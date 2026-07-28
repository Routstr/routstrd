import { createServer } from "http";
import { existsSync } from "fs";
import {
  ProviderManager,
  createStorageAdapterFromStore,
  createSdkStore,
} from "@routstr/sdk";
// ModelManager must come from the bun entrypoint so persistent Nostr event
// storage (eventStoreDbPath) gets its SQLite-backed factory. The default
// "@routstr/sdk" export is browser-safe and throws without that factory
// (SDK 0.3.7+ browser-safe entrypoint split).
import { ModelManager } from "@routstr/sdk/bun";
import type { SdkLogger } from "@routstr/sdk";
import {
  CONFIG_DIR,
  DB_PATH,
  SOCKET_PATH,
  PID_FILE,
  REQUEST_RESPONSE_LOGS_DIR,
} from "../utils/config";
import { logger } from "../utils/logger";

// ── Console noise filter ─────────────────────────────────────────
// The @routstr/sdk's SSE inspector does unconditional console.log("[routstr:sse]
// chunk:", ...) for every single streaming token. This produced a 195 MB log
// file that filled swap and caused silent OOM crashes. The SDK's own
// debugLevel flag only governs its _logger_ calls, not these raw console.log
// statements, so we intercept console.log here and drop the per-token SSE
// spam while preserving everything else (including real errors and the
// crash/shutdown markers written via process.stderr).
//
// Set ROUTSTRD_VERBOSE_SSE=1 to restore the full per-token logging (useful for
// deep SDK debugging, but it will grow the log file fast).
const _origConsoleLog = console.log.bind(console);
const _verboseSse = process.env.ROUTSTRD_VERBOSE_SSE === "1";
console.log = (...args: unknown[]) => {
  if (_verboseSse) {
    _origConsoleLog(...args);
    return;
  }
  const first = args[0];
  if (typeof first === "string" && first.startsWith("[routstr:sse]")) {
    return; // suppress per-token SSE spam
  }
  _origConsoleLog(...args);
};


function makeSdkLogger(prefix?: string): SdkLogger {
  const tag = prefix ? `[${prefix}]` : undefined;
  const fmt = (...args: unknown[]) => (tag ? [tag, ...args] : args);
  return {
    log: (...args: unknown[]) => logger.log(...fmt(...args)),
    warn: (...args: unknown[]) => logger.warn(...fmt(...args)),
    error: (...args: unknown[]) => logger.error(...fmt(...args)),
    debug: (...args: unknown[]) => logger.debug(...fmt(...args)),
    child: (p: string) => makeSdkLogger(prefix ? `${prefix}:${p}` : p),
  };
}
const daemonSdkLogger: SdkLogger = makeSdkLogger();
import { parseArgs } from "./args";
import { ensureDirs, loadDaemonConfig, loadDaemonConfigSync, saveDaemonConfig } from "./config-store";
import {
  createBunSqliteDriver,
  createBunSqliteUsageTrackingDriver,
  createShardedDiscoveryAdapter,
} from "@routstr/sdk/storage/bun";
import { createWalletAdapter } from "./wallet";
import type { AutoRefillConfig } from "./wallet/auto-refill";
import { createCocodClient } from "./wallet/cocod-client";
import { installMintFallbackTopUp } from "./wallet/sdk-mint-fallback";
import { createModelService } from "./models";
import { createDaemonRequestHandler } from "./http";
import { FileRequestResponseLogSink } from "./request-response-log-sink";
import { refreshModelsAndIntegrations } from "../integrations";
import { RoutstrClient } from "@routstr/sdk";

// ── Global error & shutdown handlers ─────────────────────────────
// The daemon is spawned detached with stdout/stderr redirected to a file,
// so without these handlers, uncaught async errors and external signals
// (SIGTERM/OOM-killer) would kill the process silently — leaving no trace
// in the structured logs. These handlers write a clear crash/shutdown marker
// (with timestamp + stack trace) to the file logger AND to stderr, so the
// cause is visible in both ~/.routstrd/logs/YYYY-MM-DD.log and the
// stdout/stderr capture file (debug.log).
//
// The daemon is a long-lived server: we do NOT exit on uncaughtException /
// unhandledRejection (a single broken request should not take down the whole
// process). We log loudly and keep running. External kill signals (SIGTERM,
// SIGINT) and process.exit() are logged as a final marker so you can always
// see exactly when and why the process stopped.

const SHUTDOWN_MARKER =
  "══════════════════════════════════════════════════";

function logToStderr(msg: string): void {
  try {
    process.stderr.write(`${msg}\n`);
  } catch {
    // stderr may be closed during final shutdown — ignore.
  }
}

process.on("uncaughtException", (error) => {
  const msg = `${SHUTDOWN_MARKER}\n[CRASH] uncaughtException at ${new Date().toISOString()}\n${error.stack || error.message || String(error)}\n${SHUTDOWN_MARKER}`;
  logger.error(msg);
  logToStderr(msg);
  // Do NOT exit — the daemon is a server; one bad request should not kill it.
  // The error is logged prominently so it can be diagnosed.
});

process.on("unhandledRejection", (reason) => {
  const detail =
    reason instanceof Error
      ? `${reason.stack || reason.message}`
      : String(reason);
  const msg = `[CRASH] unhandledRejection at ${new Date().toISOString()}\n${detail}`;
  logger.error(msg);
  logToStderr(msg);
  // Do NOT exit — same rationale as uncaughtException.
});

// Graceful shutdown signal handlers. These fire when the process is killed
// externally (systemctl stop, OOM-killer, kill <pid>, Ctrl+C). Without them
// the process just vanishes and the logs show nothing after the last request.
const shutdown = (signal: string) => {
  const msg = `[SHUTDOWN] received ${signal} at ${new Date().toISOString()}, pid=${process.pid}`;
  logger.log(msg);
  logToStderr(msg);
  // Give the file logger a moment to flush, then exit.
  setTimeout(() => process.exit(0), 200);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Final marker on exit — records the exit code so you can distinguish a
// clean shutdown (code 0) from a crash (code 1) when reading logs.
process.on("exit", (code) => {
  const msg = `[EXIT] code=${code} at ${new Date().toISOString()}, pid=${process.pid}`;
  // The file logger uses async fs/promises — it may not flush during exit,
  // so also write to stderr (which is sync) as a guaranteed record.
  logToStderr(msg);
  try {
    // Best-effort sync write to stderr is already done above; the async logger
    // may or may not flush, but the stderr capture file will have it.
  } catch {
    // ignore
  }
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const config = await loadDaemonConfig();

  const port = args.port ?? config.port ?? 8008;
  const provider = args.provider || config.provider;
  const requestResponseLogDir =
    process.env.ROUTSTRD_REQUEST_RESPONSE_LOG_DIR ||
    (config.requestResponseLogging?.enabled
      ? config.requestResponseLogging.dir || REQUEST_RESPONSE_LOGS_DIR
      : undefined);
  const requestResponseLogSink = requestResponseLogDir
    ? new FileRequestResponseLogSink({
        dir: requestResponseLogDir,
        logger: daemonSdkLogger.child("request-response-log"),
      })
    : undefined;

  await ensureDirs();

  const updatedConfig = { ...config, port, provider };
  saveDaemonConfig(updatedConfig);

  const sqliteDriver = await createBunSqliteDriver(DB_PATH, { logger: daemonSdkLogger });
  const { store, hydrate } = createSdkStore({ driver: sqliteDriver });
  await hydrate;
  const usageTrackingDriver = await createBunSqliteUsageTrackingDriver({
    dbPath: DB_PATH,
    legacyStorageDriver: sqliteDriver,
  });

  const discoveryAdapter = await createShardedDiscoveryAdapter({ driver: sqliteDriver });
  const storageAdapter = createStorageAdapterFromStore(store);
  const modelManager = new ModelManager(discoveryAdapter, {
    logger: daemonSdkLogger,
    eventStoreDbPath: `${CONFIG_DIR}/events.db`,
    routstrPubkey: config.routstrPubkey,
    nostrRelays: config.relays,
  });
  // Create shared ProviderManager for consistent failure tracking across all requests
  const providerManager = new ProviderManager(discoveryAdapter, store, daemonSdkLogger);
  const { ensureProvidersBootstrapped, getRoutstr21Models, getModelProviders, refreshProvidersAndModels } =
    createModelService(modelManager, store);

  const walletClient = createCocodClient({ cocodPath: config.cocodPath });

  // ── Auto-refill configuration ────────────────────────────────
  // Uses a getter that reads config from disk each cycle, so
  // CLI changes take effect immediately without a daemon restart.

  const getAutoRefillConfig = (): AutoRefillConfig | undefined => {
    const cfg = loadDaemonConfigSync();
    if (cfg.nwc?.autoRefill?.enabled && cfg.nwc?.connectionString) {
      return {
        threshold: cfg.nwc.autoRefill.threshold,
        amount: cfg.nwc.autoRefill.amount,
        cooldownMs: cfg.nwc.autoRefill.cooldownMs,
      };
    }
    return undefined;
  };

  const walletAdapter = await createWalletAdapter({
    cocodPath: config.cocodPath,
    walletClient,
    getAutoRefillConfig,
    nwcConnectionString: config.nwc?.connectionString,
  });

  const routeClient = new RoutstrClient(
    walletAdapter,
    storageAdapter,
    discoveryAdapter,
    "min",
    config.mode || "apikeys",
    {
      usageTrackingDriver,
      sdkStore: store,
      providerManager,
      logger: daemonSdkLogger,
      requestResponseLogSink,
    },
  );
  installMintFallbackTopUp(routeClient, walletClient, walletAdapter, daemonSdkLogger, provider);

  const refundClient = new RoutstrClient(
    walletAdapter,
    storageAdapter,
    discoveryAdapter,
    "min",
    "apikeys",
    { logger: daemonSdkLogger },
  );

  const server = createServer();
  server.on(
    "request",
    createDaemonRequestHandler({
      provider,
      server,
      store,
      walletClient,
      walletAdapter,
      storageAdapter,
      discoveryAdapter,
      modelManager,
      ensureProvidersBootstrapped,
      getRoutstr21Models,
      getModelProviders,
      refreshProvidersAndModels,
      mode: config.mode || "apikeys",
      routstrPubkey: config.routstrPubkey,
      usageTrackingDriver,
      providerManager,
      routeClient,
      refundClient,
      requestResponseLogSink,
    }),
  );

  Bun.write(PID_FILE, String(process.pid));

  try {
    if (existsSync(SOCKET_PATH)) {
      Bun.spawn(["rm", SOCKET_PATH]);
    }
  } catch {
    // Ignore
  }

  const REFRESH_INTERVAL_MS = 21 * 60 * 1000; // 21 mins

  // Recurring job to refresh routstr21 models
  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  const startModelRefreshJob = () => {
    logger.log(
      `Starting recurring model refresh job (every ${REFRESH_INTERVAL_MS / 1000 / 60 / 60} hours)`,
    );

    refreshInterval = setInterval(() => {
      (async () => {
        logger.log("Running scheduled Nostr event refresh...");
        try {
          await modelManager.refreshNostrEvents();
        } catch (error) {
          logger.error("Scheduled Nostr event refresh failed:", error);
        }

        logger.log("Running scheduled model refresh...");
        try {
          await refreshModelsAndIntegrations(getRoutstr21Models, updatedConfig, "Scheduled");
        } catch (error) {
          logger.error("Scheduled model refresh failed:", error);
        }
      })().catch((error) => logger.error("Model refresh interval escaped:", error));
    }, REFRESH_INTERVAL_MS);
  };

  const stopModelRefreshJob = () => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
      logger.log("Stopped recurring model refresh job.");
    }
  };

  // Recurring job to refund pending tokens every 42 minutes
  const REFUND_INTERVAL_MS = 42 * 60 * 1000; // 42 minutes
  let refundInterval: ReturnType<typeof setInterval> | null = null;

  const startRefundJob = async () => {
    logger.log(
      `Starting recurring refund job (every ${REFUND_INTERVAL_MS / 1000 / 60} minutes)`,
    );

    refundInterval = setInterval(() => {
      (async () => {
        logger.log("Running scheduled refund...");
        try {
          const state = store.getState() as any;
          const pendingDistribution = (state.cachedTokens || []).map(
            (t: { baseUrl: string; balance?: number }) => ({
              baseUrl: t.baseUrl,
              amount: t.balance || 0,
            }),
          );
          const apiKeysStored = (state.apiKeys || []).map(
            (k: { baseUrl: string; balance?: number }) => ({
              baseUrl: k.baseUrl,
              amount: k.balance || 0,
            }),
          );

          if (pendingDistribution.length === 0 && apiKeysStored.length === 0) {
            logger.log("No pending tokens to refund.");
            return;
          }

          const mintUrl = walletAdapter.getActiveMintUrl();
          if (!mintUrl) {
            logger.log("No active mint URL for refund.");
            return;
          }

          const spender = refundClient.getCashuSpender();
          const results = await spender.refundProviders(mintUrl);

          const successCount = results.filter(
            (r: { success: boolean }) => r.success,
          ).length;
          logger.log(
            `Scheduled refund completed: ${successCount}/${results.length} providers refunded.`,
          );

          // Also sweep pending xcashu tokens that failed inline refund
          // (e.g. "proofs already spent" — token stays in storage, needs retry)
          const xcashuTokens = (state.xcashuTokens || {}) as Record<
            string,
            unknown[]
          >;
          const xcashuCount = Object.values(xcashuTokens).reduce(
            (sum, tokens) => sum + (tokens?.length || 0),
            0,
          );
          if (xcashuCount > 0) {
            logger.log(`Sweeping ${xcashuCount} pending xcashu token(s)...`);
            const xcashuResults = await spender.refundXcashuTokens(mintUrl);
            const xcashuSuccess = xcashuResults.filter(
              (r: { success: boolean }) => r.success,
            ).length;
            logger.log(
              `xcashu sweep completed: ${xcashuSuccess}/${xcashuResults.length} tokens refunded.`,
            );
          }
        } catch (error) {
          logger.error("Scheduled refund failed:", error);
        }
      })().catch((error) => logger.error("Refund interval escaped:", error));
    }, REFUND_INTERVAL_MS);
  };

  const stopRefundJob = () => {
    if (refundInterval) {
      clearInterval(refundInterval);
      refundInterval = null;
      logger.log("Stopped recurring refund job.");
    }
  };

  server.on("close", () => {
    stopModelRefreshJob();
    stopRefundJob();

  });

  server.listen(port, async () => {
    logger.log(`Routstr daemon listening on http://localhost:${port}/v1`);
    if (requestResponseLogDir) {
      logger.log(`Raw request/response logs: ${requestResponseLogDir}`);
    }

    // Start the recurring model refresh job after initial bootstrap
    void ensureProvidersBootstrapped()
      .then(async () => {
        // Catch up on any Nostr events published since last run
        logger.log("Running initial Nostr event refresh...");
        await modelManager.refreshNostrEvents();

        startModelRefreshJob();
        startRefundJob();
        // Run an immediate refresh to populate models right away
        logger.log("Running initial model refresh...");
        await refreshModelsAndIntegrations(getRoutstr21Models, updatedConfig, "Initial");
      })
      .catch((error) => {
        logger.error("Initial model refresh failed:", error);
        // Still start the jobs even if initial refresh fails
        startModelRefreshJob();
        startRefundJob();
      });
  });
}

if (import.meta.main) {
  main().catch((error) => {
    logger.error("Failed to start Routstr daemon:", error);
    process.exit(1);
  });
}
