import { createServer } from "http";
import { existsSync } from "fs";
import {
  ModelManager,
  ProviderManager,
  createDiscoveryAdapterFromStore,
  createProviderRegistryFromStore,
  createStorageAdapterFromStore,
  createSdkStore,
} from "@routstr/sdk";
import { DB_PATH, SOCKET_PATH, PID_FILE } from "../utils/config";
import { logger } from "../utils/logger";
import { parseArgs } from "./args";
import { ensureDirs, loadDaemonConfig, saveDaemonConfig } from "./config-store";
import {
  createBunSqliteDriver,
  createBunSqliteUsageTrackingDriver,
} from "@routstr/sdk/storage";
import { createWalletAdapter } from "./wallet";
import { createCocodClient } from "./wallet/cocod-client";
import { createModelService } from "./models";
import { createDaemonRequestHandler } from "./http";
import { runIntegrationsForClients } from "../integrations";
import { getClientsList } from "../utils/clients";
import { RoutstrClient } from "@routstr/sdk";

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const config = await loadDaemonConfig();

  const port = args.port;
  const provider = args.provider || config.provider;

  await ensureDirs();

  const updatedConfig = { ...config, port, provider };
  saveDaemonConfig(updatedConfig);

  const sqliteDriver = await createBunSqliteDriver(DB_PATH);
  const { store } = await createSdkStore({ driver: sqliteDriver });
  const { Database } = await import("bun:sqlite");
  const usageTrackingDriver = createBunSqliteUsageTrackingDriver({
    dbPath: DB_PATH,
    sqlite: { Database },
    legacyStorageDriver: sqliteDriver,
  });

  const discoveryAdapter = createDiscoveryAdapterFromStore(store);
  const providerRegistry = createProviderRegistryFromStore(store);
  const storageAdapter = createStorageAdapterFromStore(store);
  const modelManager = new ModelManager(discoveryAdapter);
  // Create shared ProviderManager for consistent failure tracking across all requests
  const providerManager = new ProviderManager(providerRegistry, store);
  const { ensureProvidersBootstrapped, getRoutstr21Models, getModelProviders } =
    createModelService(modelManager);

  const walletClient = createCocodClient({ cocodPath: config.cocodPath });
  const walletAdapter = await createWalletAdapter({
    cocodPath: config.cocodPath,
    walletClient,
  });

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
      providerRegistry,
      discoveryAdapter,
      modelManager,
      ensureProvidersBootstrapped,
      getRoutstr21Models,
      getModelProviders,
      mode: config.mode || "apikeys",
      usageTrackingDriver,
      providerManager,
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

    refreshInterval = setInterval(async () => {
      logger.log("Running scheduled model refresh...");
      try {
        await getRoutstr21Models(true);
        logger.log("Scheduled model refresh completed successfully.");

        // Refresh integrations for all registered clients
        const clientIds = await getClientsList();
        if (clientIds.length > 0) {
          logger.log(`Refreshing ${clientIds.length} client integration(s)...`);
          await runIntegrationsForClients(clientIds, updatedConfig);
          logger.log("Client integrations refreshed.");
        }
      } catch (error) {
        logger.error("Scheduled model refresh failed:", error);
      }
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

    refundInterval = setInterval(async () => {
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

        const client = new RoutstrClient(
          walletAdapter,
          storageAdapter,
          providerRegistry,
          "min",
          "apikeys",
        );

        const spender = client.getCashuSpender();
        const results = await spender.refundProviders(mintUrl);

        const successCount = results.filter(
          (r: { success: boolean }) => r.success,
        ).length;
        logger.log(
          `Scheduled refund completed: ${successCount}/${results.length} providers refunded.`,
        );
      } catch (error) {
        logger.error("Scheduled refund failed:", error);
      }
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

    // Start the recurring model refresh job after initial bootstrap
    void ensureProvidersBootstrapped()
      .then(() => {
        startModelRefreshJob();
        startRefundJob(); 
        // Run an immediate refresh to populate models right away
        logger.log("Running initial model refresh...");
        return getRoutstr21Models(true);
      })
      .then(async () => {
        logger.log("Initial model refresh completed.");
        // Refresh integrations for all registered clients after initial bootstrap
        const clientIds = await getClientsList();
        if (clientIds.length > 0) {
          logger.log(`Refreshing ${clientIds.length} client integration(s)...`);
          await runIntegrationsForClients(clientIds, updatedConfig);
          logger.log("Client integrations refreshed.");
        }
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
