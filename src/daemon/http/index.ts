import { randomBytes } from "crypto";
import { type IncomingMessage, type ServerResponse } from "http";
import { Readable } from "stream";
import {
  routeRequests,
  InsufficientBalanceError,
  ProviderManager,
} from "@routstr/sdk";
import type { UsageTrackingDriver, SdkLogger } from "@routstr/sdk";
import type { RequestResponseLogSink } from "../request-response-log-sink";
import { getEncodedToken } from "@cashu/coco-core";
import type { HistoryEntry } from "@cashu/coco-core";
import { logger } from "../../utils/logger";
import { loadDaemonConfig, saveDaemonConfig } from "../config-store";
import {
  CocodHttpError,
  type CocodClient,
  type CocodState,
  type WalletRecoveryProgress,
} from "../wallet/cocod-client";
import { receiveCashuToken } from "../wallet";
import { getClientsFromStore } from "../../utils/clients";
import { getUsageSummary } from "./usage-summary";

// Hop-by-hop headers describe the *upstream* connection, not this one, and must
// never be copied onto our response. In particular, copying the upstream's
// `Transfer-Encoding: chunked` while Node also frames the streamed body as
// chunked produces a duplicated `Transfer-Encoding: chunked, chunked` header,
// which strict HTTP/1.x clients (e.g. Go's net/http) reject with
// "too many transfer encodings". Node derives Content-Length for buffered
// bodies and Transfer-Encoding: chunked for streams itself.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type ClientMode = "xcashu" | "lazyrefund" | "apikeys";

type WalletStatusOutput = {
  daemon: "running";
  wallet: "connected" | "recovering" | "error";
  walletState: CocodState;
  balances?: Record<string, number>;
  mode: ClientMode;
  error?: string;
};

type DaemonDeps = {
  provider: string | null;
  server: { close(cb?: () => void): void };
  shutdown?: () => void;
  store: any;
  walletClient: CocodClient;
  walletAdapter: any;
  storageAdapter: any;
  discoveryAdapter: any;
  modelManager: any;
  ensureProvidersBootstrapped: () => Promise<void>;
  getRoutstr21Models: (forceRefresh?: boolean) => Promise<any[]>;
  getModelProviders: (modelId: string) => Promise<any>;
  refreshProvidersAndModels: () => Promise<void>;
  mode?: ClientMode;
  /** Nostr hex pubkey for routstr review/model events (kind 38425/38423). */
  routstrPubkey?: string;
  providerManager: ProviderManager;
  refundClient: any;
  requestResponseLogSink?: RequestResponseLogSink;
};

/**
 * Extracts the client ID from an incoming request by looking up the API key
 * in the store's clientIds list.
 */
function getClientIdFromRequest(
  req: IncomingMessage,
  store: { getState(): any },
): string | undefined {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return undefined;
  }

  const apiKey = authHeader.slice(7); // Remove "Bearer " prefix

  if (!apiKey.startsWith("sk-")) {
    return undefined;
  }

  const clients = getClientsFromStore(store);
  const matchingClient = clients.find((c) => c.apiKey === apiKey);

  return matchingClient?.clientId;
}
function generateApiKey(): string {
  const bytes = randomBytes(24);
  return `sk-${bytes.toString("hex")}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const bodyText = await readBody(req);
  if (!bodyText) {
    return {};
  }

  try {
    return JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new CocodHttpError(400, "Invalid JSON body.");
  }
}

function parseLimit(value: string | null, fallback = 10): number {
  const requested = Number.parseInt(value || String(fallback), 10);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(requested, 100000) // Cap at 100k entries
    : fallback;
}

/** Normalize a provider URL for matching (add https:// and a trailing slash). */
function normalizeProviderBaseUrl(url: string): string {
  if (!url.startsWith("http")) {
    url = `https://${url}`;
  }
  return url.endsWith("/") ? url : `${url}/`;
}

/** Extract the provider base URLs a kind 38421 event advertises.
 *  Parses `u` tags first, then falls back to `content` endpoint URLs,
 *  mirroring ModelManager.bootstrapFromNostr. */
function collectProviderUrlsFromEvent(event: {
  tags: string[][];
  content: string;
}): string[] {
  const urls: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] === "u" && typeof tag[1] === "string" && tag[1]) {
      urls.push(normalizeProviderBaseUrl(tag[1]));
    }
  }
  if (urls.length > 0) return urls;
  try {
    const content = JSON.parse(event.content);
    const providers = Array.isArray(content)
      ? content
      : content.providers || [];
    for (const p of providers) {
      if (p?.endpoint_url) urls.push(normalizeProviderBaseUrl(p.endpoint_url));
    }
  } catch {
    /* unparseable content — ignore */
  }
  return urls;
}

/** Read a tag value by name from a Nostr event's tag array. */
function tagValue(tags: string[][], name: string): string | null {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string" && tag[1]) return tag[1];
  }
  return null;
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getWalletStateMessage(state: CocodState): string {
  switch (state) {
    case "LOCKED":
      return "Wallet is locked. Unlock it before performing wallet operations.";
    case "UNINITIALIZED":
      return "Wallet is not initialized. Run 'routstrd onboard' first.";
    case "RECOVERING":
      return "Wallet is recovering from a previous run. Balance and send/receive operations will be available once recovery completes.";
    case "ERROR":
      return "Wallet is in an error state.";
    default:
      return "Wallet is unavailable.";
  }
}

function respondWithError(
  res: ServerResponse,
  error: unknown,
  fallbackStatus = 500,
): void {
  if (error instanceof CocodHttpError) {
    sendJson(res, error.status, { error: error.message });
    return;
  }

  sendJson(res, fallbackStatus, { error: toErrorMessage(error) });
}

async function respond(
  res: ServerResponse,
  getPayload: () => Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    sendJson(res, 200, await getPayload());
  } catch (error) {
    respondWithError(res, error);
  }
}

function requireStringField(
  body: Record<string, unknown>,
  field: string,
): string | null {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getRequiredStringField(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = requireStringField(body, field);
  if (!value) {
    throw new CocodHttpError(400, `Missing required '${field}' field.`);
  }
  return value;
}

function getRequiredPositiveNumberField(
  body: Record<string, unknown>,
  field: string,
): number {
  const value = body[field];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  throw new CocodHttpError(400, `Missing required '${field}' field.`);
}

function optionalStringField(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getCurrentMode(deps: DaemonDeps): ClientMode {
  const stateMode = deps.store.getState()?.mode;
  return stateMode || deps.mode || "apikeys";
}

async function buildStatusOutput(
  deps: DaemonDeps,
): Promise<WalletStatusOutput> {
  const mode = getCurrentMode(deps);

  try {
    const walletState = await deps.walletClient.getStatus();
    if (walletState === "RECOVERING") {
      return {
        daemon: "running",
        wallet: "recovering",
        walletState,
        mode,
        error: getWalletStateMessage(walletState),
      };
    }
    if (walletState !== "UNLOCKED") {
      return {
        daemon: "running",
        wallet: "error",
        walletState,
        mode,
        error: getWalletStateMessage(walletState),
      };
    }

    const balances = await deps.walletAdapter.getBalances();
    return {
      daemon: "running",
      wallet: "connected",
      walletState,
      balances,
      mode,
    };
  } catch (error) {
    return {
      daemon: "running",
      wallet: "error",
      walletState: "ERROR",
      mode,
      error: toErrorMessage(error),
    };
  }
}

async function buildWalletDetails(deps: DaemonDeps): Promise<{
  state: CocodState;
  ready: boolean;
  balances?: Record<string, number>;
  unit?: "sat";
  activeMint?: string | null;
  defaultMint?: string | null;
  recovery?: WalletRecoveryProgress;
}> {
  const state = await deps.walletClient.getStatus();
  const recovery = await deps.walletClient.getRecoveryProgress?.();
  if (state !== "UNLOCKED") {
    return { state, ready: false, ...(recovery ? { recovery } : {}) };
  }

  const [balances, defaultMint] = await Promise.all([
    deps.walletAdapter.getBalances(),
    deps.walletClient.getDefaultMint(),
  ]);
  return {
    state,
    ready: true,
    balances,
    unit: "sat",
    activeMint: deps.walletAdapter.getActiveMintUrl(),
    defaultMint,
    ...(recovery ? { recovery } : {}),
  };
}

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
const sdkLogger: SdkLogger = makeSdkLogger();

export function createDaemonRequestHandler(deps: {
  provider: string | null;
  server: { close(cb?: () => void): void };
  shutdown?: () => void;
  store: any;
  walletClient: CocodClient;
  walletAdapter: any;
  storageAdapter: any;
  discoveryAdapter: any;
  modelManager: any;
  ensureProvidersBootstrapped: () => Promise<void>;
  getRoutstr21Models: (forceRefresh?: boolean) => Promise<any[]>;
  getModelProviders: (modelId: string) => Promise<any>;
  refreshProvidersAndModels: () => Promise<void>;
  mode?: "xcashu" | "apikeys";
  /** Default max_tokens/max_output_tokens to inject when the client omits one. */
  maxTokens: number;
  /** Nostr hex pubkey for routstr review/model events (kind 38425/38423). */
  routstrPubkey?: string;
  usageTrackingDriver: UsageTrackingDriver;
  providerManager: ProviderManager;
  refundClient: any;
  requestResponseLogSink?: RequestResponseLogSink;
}) {
  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/ping") {
      sendJson(res, 200, { output: "pong" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      const output = await buildStatusOutput(deps);
      sendJson(res, 200, { output });
      return;
    }

    if (req.method === "GET" && url.pathname === "/wallet/status") {
      await respond(res, async () => ({
        output: await buildWalletDetails(deps),
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/unlock") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const passphrase = getRequiredStringField(body, "passphrase");
        const message = await deps.walletClient.unlock(passphrase);
        const state = await deps.walletClient.getStatus();
        return { output: { message, state } };
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/wallet/balance") {
      await respond(res, async () => {
        const balances = await deps.walletAdapter.getBalances();
        return {
          output: {
            balances,
            unit: "sat",
            activeMint: deps.walletAdapter.getActiveMintUrl(),
            walletState: "UNLOCKED",
          },
        };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/cleanup") {
      await respond(res, async () => {
        if (!deps.walletClient.cleanupStuckOperations) {
          throw new CocodHttpError(
            501,
            "Wallet cleanup is not supported by this wallet client.",
          );
        }

        const body = await readJsonBody(req);
        const result = await deps.walletClient.cleanupStuckOperations({
          mintUrl: optionalStringField(body, "mintUrl"),
          minAgeMs:
            typeof body.minAgeMs === "number" && Number.isFinite(body.minAgeMs)
              ? body.minAgeMs
              : undefined,
          dryRun: body.dryRun === true,
        });
        return { output: result };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/receive/cashu") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const token = getRequiredStringField(body, "token");
        return {
          output: await receiveCashuToken(deps.walletClient, token),
        };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/receive/bolt11") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const amount = getRequiredPositiveNumberField(body, "amount");
        const mintUrl = optionalStringField(body, "mintUrl");
        const invoice = await deps.walletClient.receiveBolt11(amount, mintUrl);
        return { output: { invoice, amount, mintUrl } };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/send/cashu") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const amount = getRequiredPositiveNumberField(body, "amount");
        const mintUrl = optionalStringField(body, "mintUrl");
        const token = await deps.walletClient.sendCashu(amount, mintUrl);
        return { output: { token, amount, mintUrl } };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/send/bolt11") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const invoice = getRequiredStringField(body, "invoice");
        const mintUrl = optionalStringField(body, "mintUrl");
        const message = await deps.walletClient.sendBolt11(invoice, mintUrl);
        return { output: { message, invoice, mintUrl } };
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/wallet/mints") {
      await respond(res, async () => {
        const [mints, defaultMint] = await Promise.all([
          deps.walletClient.listMints(),
          deps.walletClient.getDefaultMint(),
        ]);
        return {
          output: {
            mints,
            activeMint: defaultMint,
            defaultMint,
          },
        };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/mints") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const mintUrl = getRequiredStringField(body, "url");
        const message = await deps.walletClient.addMint(mintUrl);
        return { output: { message, url: mintUrl } };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/mints/info") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const mintUrl = getRequiredStringField(body, "url");
        const info = await deps.walletClient.getMintInfo(mintUrl);
        return { output: { url: mintUrl, info } };
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/wallet/mints/default") {
      await respond(res, async () => {
        const defaultMint = await deps.walletClient.getDefaultMint();
        return { output: { defaultMint } };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/mints/default") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const mintUrl = getRequiredStringField(body, "url");
        const message = await deps.walletClient.setDefaultMint(mintUrl);
        return { output: { message, url: mintUrl } };
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/wallet/history") {
      await respond(res, async () => {
        const offsetParam = url.searchParams.get("offset");
        const limitParam = url.searchParams.get("limit");
        const offset = offsetParam ? parseInt(offsetParam, 10) || 0 : 0;
        const limit = limitParam ? parseInt(limitParam, 10) || 50 : 50;
        const entries = await deps.walletClient.getHistory(offset, limit);

        const encoded = entries.map((entry: HistoryEntry) => {
          const base = { ...entry } as Record<string, unknown>;
          if (
            (entry.type === "send" || entry.type === "receive") &&
            entry.token
          ) {
            base.encodedToken = getEncodedToken(entry.token);
          }
          return base;
        });

        return { output: { entries: encoded, offset, limit } };
      });
      return;
    }

    // ── NPC (npubx.cash) Lightning address endpoints ──────────────

    if (req.method === "GET" && url.pathname === "/wallet/npc/address") {
      await respond(res, async () => {
        const info = await deps.walletClient.getNpcAddress();
        return { output: info };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/npc/username") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const username = getRequiredStringField(body, "username");
        const confirm = body.confirm === true;
        const result = await deps.walletClient.setNpcUsername(username, confirm);
        if (!result.success) {
          const pr = result.paymentRequest ?? {};
          const amount = typeof pr.amount === "number" ? pr.amount : 0;
          const mints = Array.isArray(pr.mints) ? pr.mints.join(", ") : "";
          if (confirm) {
            throw new CocodHttpError(
              402,
              `Failed to set username. Required amount: ${amount} SATS. Required mints: ${mints}`,
            );
          }
          throw new CocodHttpError(
            402,
            `Payment required to set username: ${amount} SATS. ` +
              `Use 'routstrd wallet npc username ${username} --confirm' to proceed`,
          );
        }
        return { output: { success: true, username } };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/wallet/npc/sync") {
      await respond(res, async () => {
        await deps.walletClient.syncNpc();
        return { output: { message: "NPC sync completed" } };
      });
      return;
    }

    // ── NWC endpoints ─────────────────────────────────────────────

    if (req.method === "GET" && url.pathname === "/nwc/status") {
      await respond(res, async () => {
        const status = await deps.walletAdapter.getNwcStatus();
        const autoRefill = deps.walletAdapter.getAutoRefillConfig();
        return {
          output: {
            ...status,
            autoRefill: autoRefill
              ? {
                  enabled: autoRefill.enabled,
                  threshold: autoRefill.threshold,
                  amount: autoRefill.amount,
                  cooldownMs: autoRefill.cooldownMs,
                  cooldownMinutes: autoRefill.cooldownMs / 60000,
                }
              : undefined,
          },
        };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/nwc/connect") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const connectionString = getRequiredStringField(body, "connectionString");

        // Reload config and set NWC connection
        const config = await loadDaemonConfig();
        config.nwc = {
          mode: "funding_source",
          connectionString,
          autoRefill: config.nwc?.autoRefill,
        };
        saveDaemonConfig(config);

        // Hot-reload: reconnect the wallet adapter with the new connection string
        await deps.walletAdapter.reconnect(connectionString);

        return {
          output: {
            message: "NWC connection string saved and connected.",
          },
        };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/nwc/disconnect") {
      await respond(res, async () => {
        const config = await loadDaemonConfig();
        if (config.nwc) {
          delete config.nwc.connectionString;
          if (config.nwc.autoRefill) {
            config.nwc.autoRefill.enabled = false;
          }
        }
        saveDaemonConfig(config);

        // Hot-reload: disconnect the wallet adapter
        await deps.walletAdapter.reconnect();

        return {
          output: { message: "NWC disconnected." },
        };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/nwc/fund") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const amount = getRequiredPositiveNumberField(body, "amount");
        const result = await deps.walletAdapter.fundFromNWC(amount);
        if (!result.success) {
          throw new Error(result.error || "NWC funding failed");
        }
        const balances = await deps.walletAdapter.getBalances();
        const activeMint = deps.walletAdapter.getActiveMintUrl();
        const balance = activeMint ? (balances[activeMint] ?? 0) : 0;

        return {
          output: {
            message: `Successfully funded ${amount} sats via NWC`,
            amount,
            balance,
          },
        };
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/nwc/auto-refill") {
      await respond(res, async () => {
        const body = await readJsonBody(req);
        const enabled = body.enabled === true || body.enabled === "true";

        const config = await loadDaemonConfig();
        if (!config.nwc) {
          config.nwc = { mode: "funding_source" };
        }

        if (enabled) {
          const threshold =
            typeof body.threshold === "number" && body.threshold > 0
              ? body.threshold
              : 500;
          const amount =
            typeof body.amount === "number" && body.amount > 0
              ? body.amount
              : 1000;
          const cooldownMs =
            typeof body.cooldownMs === "number" && body.cooldownMs > 0
              ? body.cooldownMs
              : 300000;

          config.nwc.autoRefill = {
            enabled: true,
            threshold,
            amount,
            cooldownMs,
          };
        } else {
          config.nwc.autoRefill = config.nwc.autoRefill
            ? { ...config.nwc.autoRefill, enabled: false }
            : { enabled: false, threshold: 500, amount: 1000, cooldownMs: 300000 };
        }

        saveDaemonConfig(config);

        return {
          output: {
            message: `Auto-refill ${enabled ? "enabled" : "disabled"}.`,
            autoRefill: {
              ...config.nwc.autoRefill,
              cooldownMinutes: config.nwc.autoRefill.cooldownMs / 60000,
            },
          },
        };
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/models") {
      try {
        const forceRefresh =
          url.searchParams.get("refresh")?.toLowerCase() === "true";
        const models = await deps.getRoutstr21Models(forceRefresh);
        sendJson(res, 200, { output: { models } });
      } catch (error) {
        sendJson(res, 500, { error: toErrorMessage(error) });
      }
      return;
    }

    // Get providers for a specific model
    const modelProvidersMatch = url.pathname.match(/^\/models\/([^\/]+)\/providers$/);
    if (req.method === "GET" && modelProvidersMatch && modelProvidersMatch[1]) {
      try {
        const modelId = decodeURIComponent(modelProvidersMatch[1]);
        const modelWithProviders = await deps.getModelProviders(modelId);
        if (!modelWithProviders) {
          sendJson(res, 404, { error: `Model '${modelId}' not found` });
          return;
        }
        sendJson(res, 200, { output: modelWithProviders });
      } catch (error) {
        sendJson(res, 500, { error: toErrorMessage(error) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      try {
        const forceRefresh =
          url.searchParams.get("refresh")?.toLowerCase() === "true";
        const models = await deps.getRoutstr21Models(forceRefresh);
        sendJson(res, 200, {
          object: "list",
          data: models.map((model) => ({ ...model, object: "model" })),
        });
      } catch (error) {
        sendJson(res, 500, { error: toErrorMessage(error) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/stop") {
      sendJson(res, 200, { output: "stopping" });
      setTimeout(() => {
        if (deps.shutdown) {
          deps.shutdown();
        } else {
          deps.server.close(() => process.exit(0));
        }
      }, 50);
      return;
    }

    if (req.method === "POST" && url.pathname === "/refund") {
      try {
        const body = await readJsonBody(req);
        const mintUrl = getRequiredStringField(body, "mintUrl");

        const state = deps.store.getState();
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
          sendJson(res, 200, {
            output: { message: "No pending tokens to refund", results: [] },
          });
          return;
        }

        const refundBaseUrls = pendingDistribution
          .map((p: { baseUrl: string }) => p.baseUrl)
          .concat(apiKeysStored.map((p: { baseUrl: string }) => p.baseUrl));

        const spender = deps.refundClient.getCashuSpender();
        const results = await spender.refundProviders(mintUrl, true);

        sendJson(res, 200, {
          output: {
            message: `Refunded to ${mintUrl}`,
            pendingTokens: pendingDistribution.length,
            apiKeys: apiKeysStored.length,
            results: results.map(
              (r: { baseUrl: string; success: boolean }) => ({
                baseUrl: r.baseUrl,
                success: r.success,
              }),
            ),
          },
        });
      } catch (error) {
        logger.error(`Refund error: ${toErrorMessage(error)}`);
        respondWithError(res, error);
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/refund/xcashu") {
      try {
        const body = await readJsonBody(req);
        const mintUrl = getRequiredStringField(body, "mintUrl");

        const spender = deps.refundClient.getCashuSpender();
        const results = await spender.refundXcashuTokens(mintUrl);

        sendJson(res, 200, {
          output: {
            message: `Refunded xcashu tokens to ${mintUrl}`,
            results: results.map(
              (r: { baseUrl: string; token: string; success: boolean; error?: string }) => ({
                baseUrl: r.baseUrl,
                token: r.token,
                success: r.success,
                error: r.error,
              }),
            ),
          },
        });
      } catch (error) {
        logger.error(`xcashu refund error: ${toErrorMessage(error)}`);
        respondWithError(res, error);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/balance") {
      try {
        const balances = await deps.walletAdapter.getBalances();
        sendJson(res, 200, {
          output: {
            balances,
            unit: "sat",
            activeMint: deps.walletAdapter.getActiveMintUrl(),
          },
        });
      } catch (error) {
        respondWithError(res, error);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/keys/balance") {
      try {
        const walletBalances = await deps.walletAdapter.getBalances();
        const totalWallet = Object.values(walletBalances).reduce<number>(
          (sum, balance) => sum + Number(balance),
          0,
        );

        const state = deps.store.getState();
        const cachedTokens = state.cachedTokens || [];
        const totalCached = cachedTokens.reduce(
          (sum: number, t: { balance?: number }) => sum + (t.balance || 0),
          0,
        );

        const apiKeys = state.apiKeys || [];
        const totalApiKeys = apiKeys.reduce(
          (sum: number, k: { balance?: number }) => sum + (k.balance || 0),
          0,
        );

        const keys: Array<{ id: string; name: string; balance: number }> = [
          { id: "wallet", name: "Wallet", balance: totalWallet },
          ...cachedTokens.map((t: { baseUrl: string; balance?: number }) => ({
            id: `cached:${t.baseUrl}`,
            name: `Cached: ${t.baseUrl}`,
            balance: t.balance || 0,
          })),
          ...apiKeys.map((k: { baseUrl: string; balance?: number }) => ({
            id: `apikey:${k.baseUrl}`,
            name: `API Key: ${k.baseUrl}`,
            balance: k.balance || 0,
          })),
        ];

        sendJson(res, 200, {
          output: {
            keys,
            total: totalWallet + totalCached + totalApiKeys,
            unit: "sat",
            apikeysCalled: apiKeys.length,
          },
        });
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/keys/api") {
      try {
        const apiKeys = deps.storageAdapter.getAllApiKeys() as Array<{
          baseUrl: string;
          key: string;
          balance: number;
          lastUsed: number | null;
        }>;
        const totalApiKeys = apiKeys.reduce(
          (sum: number, k) => sum + (k.balance || 0),
          0,
        );
        sendJson(res, 200, {
          output: {
            apiKeys,
            count: apiKeys.length,
            total: totalApiKeys,
            unit: "sat",
          },
        });
      } catch (error) {
        respondWithError(res, error);
      }
      return;
    }

    // Refund remaining balance to a mint before removing the key.
    const apiKeyDeleteMatch =
      (req.method === "DELETE" || req.method === "POST") &&
      url.pathname === "/keys/api/delete";
    if (apiKeyDeleteMatch) {
      try {
        let baseUrl: string | undefined;
        let mintUrl: string | undefined;
        if (req.method === "DELETE") {
          baseUrl = url.searchParams.get("baseUrl") || undefined;
          mintUrl = url.searchParams.get("mintUrl") || undefined;
        } else {
          const body = await readJsonBody(req);
          baseUrl = getRequiredStringField(body, "baseUrl");
          mintUrl = body.mintUrl as string | undefined;
        }
        if (!baseUrl) {
          sendJson(res, 400, {
            error: "Missing required 'baseUrl' field.",
          });
          return;
        }

        const existing = deps.storageAdapter.getApiKey(baseUrl);
        if (!existing) {
          sendJson(res, 200, {
            output: {
              baseUrl,
              removed: false,
              refunded: false,
              message: `No API key found for ${baseUrl}`,
            },
          });
          return;
        }

        if (!mintUrl) {
          try {
            mintUrl =
              deps.walletAdapter.getActiveMintUrl() ??
              Object.keys(await deps.walletAdapter.getBalances())[0];
          } catch {
            // ignore
          }
        }

        let refunded = false;
        let refundMessage: string | undefined;
        let refundedAmount: number | undefined;

        if (mintUrl) {
          try {
            const balanceManager = deps.refundClient.getBalanceManager();
            if (balanceManager) {
              const refundResult = await balanceManager.refundApiKey({
                mintUrl,
                baseUrl: existing.baseUrl,
                apiKey: existing.key,
                forceRefund: true,
              });
              refunded = refundResult.success;
              refundMessage = refundResult.message;
              if (refundResult.refundedAmount) {
                refundedAmount = Math.floor(
                  refundResult.refundedAmount / 1000,
                );
              }
            }
          } catch (error) {
            refundMessage = `Refund error: ${toErrorMessage(error)}`;
          }
        } else {
          refundMessage = "No mint available to refund to";
        }

        // refundApiKey removes the key on success; remove manually on failure.
        if (!refunded) {
          deps.storageAdapter.removeApiKey(existing.baseUrl);
        }

        sendJson(res, 200, {
          output: {
            baseUrl: existing.baseUrl,
            removed: true,
            refunded,
            refundedAmount,
            refundMessage,
            message: refunded
              ? `Refunded and removed API key for ${existing.baseUrl}`
              : `Removed API key for ${existing.baseUrl} (refund failed: ${refundMessage ?? "unknown"})`,
          },
        });
      } catch (error) {
        respondWithError(res, error);
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/providers/disable") {
      try {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const indices = body.indices as number[] | undefined;

        if (!Array.isArray(indices)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing or invalid 'indices' field (expected number[]).",
            }),
          );
          return;
        }

        const state = deps.store.getState();
        const baseUrlsList: string[] = state.baseUrlsList || [];
        // User-driven disables belong in the *manual* disabled list. The
        // review-based list (setDisabledProviders) is owned by the Nostr
        // kind-38425 review sync, which overwrites it and would otherwise
        // silently re-enable manually-disabled providers. Disabling also
        // clears any manual-enable override for that provider.
        const manuallyDisabledProviders: string[] = [
          ...(state.manuallyDisabledProviders || []),
        ];
        const manuallyEnabledProviders: string[] = [
          ...(state.manuallyEnabledProviders || []),
        ];

        const toDisable: string[] = [];
        for (const idx of indices) {
          if (
            typeof idx === "number" &&
            idx >= 0 &&
            idx < baseUrlsList.length
          ) {
            const baseUrl = baseUrlsList[idx]!;
            if (!manuallyDisabledProviders.includes(baseUrl)) {
              manuallyDisabledProviders.push(baseUrl);
              toDisable.push(baseUrl);
            }
            const enabledPos = manuallyEnabledProviders.indexOf(baseUrl);
            if (enabledPos !== -1) {
              manuallyEnabledProviders.splice(enabledPos, 1);
            }
          }
        }

        deps.store.getState().setManuallyDisabledProviders(manuallyDisabledProviders);
        deps.discoveryAdapter.setManuallyDisabledProviders(manuallyDisabledProviders);
        deps.store.getState().setManuallyEnabledProviders(manuallyEnabledProviders);
        deps.discoveryAdapter.setManuallyEnabledProviders(manuallyEnabledProviders);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              message: `Disabled ${toDisable.length} provider(s)`,
              disabled: toDisable,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/providers/enable") {
      try {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const indices = body.indices as number[] | undefined;

        if (!Array.isArray(indices)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing or invalid 'indices' field (expected number[]).",
            }),
          );
          return;
        }

        const state = deps.store.getState();
        const baseUrlsList: string[] = state.baseUrlsList || [];
        // Re-enabling clears the manual disable and records a manual-enable
        // override so the review sync (which disables providers without an
        // lgtm review) does not silently re-disable it on the next pass.
        const manuallyDisabledProviders: string[] = [
          ...(state.manuallyDisabledProviders || []),
        ];
        const manuallyEnabledProviders: string[] = [
          ...(state.manuallyEnabledProviders || []),
        ];

        const toEnable: string[] = [];
        for (const idx of indices) {
          if (
            typeof idx === "number" &&
            idx >= 0 &&
            idx < baseUrlsList.length
          ) {
            const baseUrl = baseUrlsList[idx]!;
            const pos = manuallyDisabledProviders.indexOf(baseUrl);
            if (pos !== -1) {
              manuallyDisabledProviders.splice(pos, 1);
            }
            if (!manuallyEnabledProviders.includes(baseUrl)) {
              manuallyEnabledProviders.push(baseUrl);
            }
            toEnable.push(baseUrl);
          }
        }

        deps.store.getState().setManuallyDisabledProviders(manuallyDisabledProviders);
        deps.discoveryAdapter.setManuallyDisabledProviders(manuallyDisabledProviders);
        deps.store.getState().setManuallyEnabledProviders(manuallyEnabledProviders);
        deps.discoveryAdapter.setManuallyEnabledProviders(manuallyEnabledProviders);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              message: `Enabled ${toEnable.length} provider(s)`,
              enabled: toEnable,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    // Client management endpoints
    if (req.method === "GET" && url.pathname === "/clients") {
      try {
        const clients = getClientsFromStore(deps.store).map((c) => ({
          id: c.clientId,
          name: c.name,
          apiKey: c.apiKey,
          createdAt: c.createdAt,
          lastUsed: c.lastUsed,
          ownerNpub: c.ownerNpub,
        }));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              clients,
              totalCount: clients.length,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/clients/add") {
      try {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const name = body.name as string | undefined;
        const explicitId = body.id as string | undefined;
        const ownerNpub = body.ownerNpub as string | undefined;

        if (!name || typeof name !== "string" || name.trim() === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "Missing required 'name' field (must be a non-empty string).",
            }),
          );
          return;
        }

        if (!explicitId || typeof explicitId !== "string" || explicitId.trim() === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "Missing required 'id' field (must be a non-empty string).",
            }),
          );
          return;
        }

        const sanitizeId = (value: string) =>
          value
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9-]/g, "");

        const clientId = sanitizeId(explicitId);

        if (!clientId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "Invalid client id. Must contain alphanumeric characters.",
            }),
          );
          return;
        }

        const existingClients = getClientsFromStore(deps.store);
        const existingClient = existingClients.find(
          (c) => c.clientId === clientId,
        );

        if (existingClient) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Client with id '${clientId}' already exists.`,
            }),
          );
          return;
        }

        const apiKey = generateApiKey();
        const newClient = {
          clientId,
          name: name.trim(),
          apiKey,
          createdAt: Date.now(),
          ...(ownerNpub && typeof ownerNpub === "string" ? { ownerNpub } : {}),
        };

        deps.store
          .getState()
          .setClientIds((prev: typeof existingClients) => [
            ...(prev || []),
            newClient,
          ]);

        logger.log(`Added client '${name}' with id '${clientId}'`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              message: `Client '${name}' added successfully`,
              client: {
                id: clientId,
                name: name.trim(),
                apiKey,
                createdAt: newClient.createdAt,
                ownerNpub: newClient.ownerNpub,
              },
            },
          }),
        );
      } catch (error) {
        respondWithError(res, error);
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/clients/delete") {
      try {
        const bodyText = await readBody(req);
        const body = bodyText ? JSON.parse(bodyText) : {};
        const id = body.id as string | undefined;

        if (!id || typeof id !== "string" || id.trim() === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error:
                "Missing required 'id' field (must be a non-empty string).",
            }),
          );
          return;
        }

        const existingClients = getClientsFromStore(deps.store);
        const index = existingClients.findIndex(
          (c) => c.clientId === id,
        );

        if (index === -1) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `Client with id '${id}' not found.`,
            }),
          );
          return;
        }

        const removedClient = existingClients[index]!;
        const updatedClients = existingClients.filter(
          (_c: unknown, i: number) => i !== index,
        );

        deps.store.getState().setClientIds(updatedClients);

        logger.log(
          `Deleted client '${removedClient.name}' with id '${id}'`,
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              message: `Client '${removedClient.name}' deleted successfully`,
              id,
            },
          }),
        );
      } catch (error) {
        respondWithError(res, error);
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/providers") {
      try {
        const forceRefresh =
          url.searchParams.get("refresh")?.toLowerCase() === "true";

        if (forceRefresh) {
          logger.log("Force-refreshing providers from Nostr and fetching models...");
          await deps.refreshProvidersAndModels();
        }

        const state = deps.store.getState();
        const baseUrlsList: string[] = state.baseUrlsList || [];
        const manuallyEnabled = new Set(
          state.manuallyEnabledProviders || [],
        );
        const disabledProviders: string[] = [
          ...new Set([
            ...(state.disabledProviders || []),
            ...(state.manuallyDisabledProviders || []),
          ]),
        ].filter((url) => !manuallyEnabled.has(url));

        const providers = baseUrlsList.map((baseUrl, index) => ({
          index,
          baseUrl,
          disabled: disabledProviders.includes(baseUrl),
        }));

        // Only count disabled providers that are actually in the current list
        // (filter out stale entries from previously disabled providers that are no longer present)
        const activeDisabledCount = providers.filter((p) => p.disabled).length;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              providers,
              disabledCount: activeDisabledCount,
              totalCount: baseUrlsList.length,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/providers/reviews") {
      try {
        const state = deps.store.getState();
        const baseUrlsList: string[] = state.baseUrlsList || [];

        // Read disable state from the discovery adapter (the same source the
        // router/ProviderManager uses), not the mirror in the SdkStore, which
        // can lag behind the review sync on warm boots.
        const manuallyEnabled = new Set(
          deps.discoveryAdapter.getManuallyEnabledProviders?.() || [],
        );
        const disabledSet = new Set(
          [
            ...(deps.discoveryAdapter.getDisabledProviders() || []),
            ...(deps.discoveryAdapter.getManuallyDisabledProviders() || []),
          ].filter((u: string) => !manuallyEnabled.has(u)),
        );

        // url -> set of node pubkeys advertised by that provider's 38421 event(s)
        const providerNodes = new Map<string, Set<string>>();
        // All stored kind 38425 review events
        const reviewEvents: any[] = [];

        const eventStore = await deps.modelManager.getEventStore();
        if (eventStore) {
          const providerEvents = eventStore.getTimeline({ kinds: [38421] });
          for (const ev of providerEvents) {
            const pubkey = ev.pubkey;
            for (const u of collectProviderUrlsFromEvent(ev)) {
              let set = providerNodes.get(u);
              if (!set) {
                set = new Set<string>();
                providerNodes.set(u, set);
              }
              set.add(pubkey);
            }
          }
          reviewEvents.push(...eventStore.getTimeline({ kinds: [38425] }));
        }

        const mapReview = (rv: any) => ({
          eventId: rv.id,
          createdAt: rv.created_at,
          authorPubkey: rv.pubkey,
          nodePubkey: tagValue(rv.tags, "node"),
          label: tagValue(rv.tags, "t") ?? "",
          isLgtm:
            (tagValue(rv.tags, "t") ?? "").toLowerCase() === "lgtm",
          tags: rv.tags,
        });

        const providers = baseUrlsList.map((baseUrl, index) => {
          const normalized = normalizeProviderBaseUrl(baseUrl);
          const nodePubkeys = Array.from(
            providerNodes.get(normalized) || new Set<string>(),
          );
          const reviews = reviewEvents
            .filter((rv) => {
              const node = tagValue(rv.tags, "node");
              return node ? nodePubkeys.includes(node) : false;
            })
            .sort((a, b) => b.created_at - a.created_at)
            .map(mapReview);
          return {
            index,
            baseUrl,
            disabled: disabledSet.has(baseUrl),
            nodePubkeys,
            reviewCount: reviews.length,
            reviews,
          };
        });

        // Review events that reference a node pubkey we could not map back to
        // any currently-known provider URL (kept for completeness).
        const knownNodePubkeys = new Set<string>();
        for (const set of providerNodes.values()) {
          for (const pk of set) knownNodePubkeys.add(pk);
        }
        const unmatchedReviews = reviewEvents
          .filter((rv) => {
            const node = tagValue(rv.tags, "node");
            return node ? !knownNodePubkeys.has(node) : false;
          })
          .sort((a, b) => b.created_at - a.created_at)
          .map(mapReview);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              providers,
              unmatchedReviews,
              totalCount: baseUrlsList.length,
              reviewEventCount: reviewEvents.length,
            },
          }),
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/usage") {
      try {
        const npubFilter = url.searchParams.get("npub")?.trim();
        const clients = npubFilter ? getClientsFromStore(deps.store) : undefined;
        const clientFilter = npubFilter
          ? clients!
              .filter((c) => c.ownerNpub === npubFilter)
              .map((c) => c.clientId)
          : undefined;
        const output = await deps.usageTrackingDriver.list({
          limit: parseLimit(url.searchParams.get("limit")),
          ...(clientFilter ? { clients: clientFilter } : {}),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ output }));
      } catch (error) {
        sendJson(res, 500, { error: toErrorMessage(error) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/usage/summary") {
      try {
        const tz = Number.parseInt(url.searchParams.get("tz") || "0", 10) || 0;
        const npubFilter = url.searchParams.get("npub")?.trim();
        const clients = getClientsFromStore(deps.store);
        const clientFilter = npubFilter
          ? clients
              .filter((c) => c.ownerNpub === npubFilter)
              .map((c) => c.clientId)
          : undefined;
        const summary = await getUsageSummary(deps.usageTrackingDriver, clients, tz, clientFilter);
        sendJson(res, 200, { output: summary });
      } catch (error) {
        sendJson(res, 500, { error: toErrorMessage(error) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/usagePi") {
      try {
        const timestamp = (url.searchParams.get("timestamp") || "").trim();
        if (!timestamp) {
          sendJson(res, 400, {
            error: "Missing required 'timestamp' query parameter.",
          });
          return;
        }

        const usageDriver = deps.usageTrackingDriver;
        const limit = parseLimit(url.searchParams.get("limit"));
        const allMatching = await usageDriver.list();
        const requestIdPrefix = `gen-${timestamp}-`;
        const filtered = allMatching.filter((entry) =>
          entry.requestId.startsWith(requestIdPrefix),
        );
        const entries = filtered.slice(0, limit);
        const totalEntries = filtered.length;
        const totalSatsCost = filtered.reduce(
          (sum, entry) => sum + (entry.satsCost || 0),
          0,
        );
        const recentSatsCost = entries.reduce(
          (sum, entry) => sum + (entry.satsCost || 0),
          0,
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            output: {
              entries,
              totalEntries,
              totalSatsCost,
              recentSatsCost,
              limit,
              timestamp,
            },
          }),
        );
      } catch (error) {
        sendJson(res, 500, { error: toErrorMessage(error) });
      }
      return;
    }

    if (
      req.method !== "POST" &&
      !url.pathname.startsWith("/clients") &&
      !url.pathname.startsWith("/keys/api")
    ) {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Only POST is supported." }));
      return;
    }

    let requestBody: unknown = {};
    try {
      requestBody = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, {
        error: "Invalid JSON body.",
        details: toErrorMessage(error),
      });
      return;
    }

    const bodyObj = requestBody as Record<string, unknown>;
    const modelId = typeof bodyObj.model === "string" ? bodyObj.model : "";

    if (!modelId) {
      sendJson(res, 400, { error: "Missing required 'model' field." });
      return;
    }

    // Cap the completion budget when the client does not set an output token
    // limit. Without this, the SDK prices at the provider's worst-case
    // max_completion_cost, which varies widely across providers (2.3× for
    // kimi-k3) and balloons during provider failover. Chat/completions use
    // max_tokens; the OpenAI Responses API uses max_output_tokens.
    if (deps.maxTokens > 0) {
      const isResponsesPath = url.pathname.includes("/responses");
      if (isResponsesPath) {
        if (typeof bodyObj.max_output_tokens !== "number") {
          bodyObj.max_output_tokens = deps.maxTokens;
        }
      } else if (typeof bodyObj.max_tokens !== "number") {
        bodyObj.max_tokens = deps.maxTokens;
      }
    }

    const forcedProvider: string | undefined =
      url.searchParams.get("provider") ||
      (req.headers["x-routstr-provider"] as string | undefined) ||
      deps.provider ||
      undefined;

    // Convert req.headers to Record<string, string>
    const incomingHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        incomingHeaders[key] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        incomingHeaders[key] = value[0]!;
      }
    }

    try {
      await deps.ensureProvidersBootstrapped();
      const reqId = randomBytes(4).toString("hex");
      const reqLogger = sdkLogger.child(`req:${reqId}`);
      logger.log(`[req:${reqId}] Routing request with path: `, url.pathname);

      const response = await routeRequests({
        modelId,
        requestBody,
        path: url.pathname,
        forcedProvider,
        headers: incomingHeaders,
        walletAdapter: deps.walletAdapter,
        storageAdapter: deps.storageAdapter,
        discoveryAdapter: deps.discoveryAdapter,
        modelManager: deps.modelManager,
        debugLevel: "DEBUG",
        mode: deps.mode,
        usageTrackingDriver: deps.usageTrackingDriver,
        sdkStore: deps.store,
        providerManager: deps.providerManager,
        logger: reqLogger,
        ...(deps.requestResponseLogSink
          ? { requestResponseLogSink: deps.requestResponseLogSink }
          : {}),
        ...(deps.routstrPubkey ? { routstrPubkey: deps.routstrPubkey } : {}),
      });

      // Bridge the Web `Response` to the Node `ServerResponse`: status +
      // headers + pipe(body → res). Hop-by-hop headers are dropped (see
      // HOP_BY_HOP_HEADERS) so Node computes correct framing for THIS
      // connection.
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
        res.setHeader(key, value);
      });

      const finalize = (response as any).finalize as
        | (() => Promise<number>)
        | undefined;

      if (!response.body) {
        res.end();
        if (finalize) {
          try {
            await finalize();
          } catch (err) {
            logger.error(`[daemon] finalize error: ${toErrorMessage(err)}`);
          }
        }
        return;
      }

      const nodeReadable = Readable.fromWeb(response.body as any);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          reject(err);
        };
        res.once("finish", finish);
        res.once("close", finish);
        res.once("error", fail);
        nodeReadable.once("error", fail);
        nodeReadable.pipe(res);
      });

      if (finalize) {
        try {
          await finalize();
        } catch (err) {
          logger.error(`[daemon] finalize error: ${toErrorMessage(err)}`);
        }
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[daemon] Error: ${message}`);

      if (error instanceof InsufficientBalanceError) {
        const balanceError = error as {
          required?: number;
          available?: number;
          maxMintBalance?: number;
          maxMintUrl?: string;
        };
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: message,
            error_type: "insufficient_balance",
            required: balanceError.required,
            available: balanceError.available,
            maxMintBalance: balanceError.maxMintBalance,
            maxMintUrl: balanceError.maxMintUrl,
          }),
        );
        return;
      }

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  };
}
