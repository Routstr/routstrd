import {
  initializeCoco,
  getEncodedToken,
  normalizeMintUrl,
} from "@cashu/coco-core";
import type {
  HistoryEntry,
  Logger as CocoLogger,
  Plugin as CocoPlugin,
} from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { Database } from "bun:sqlite";
import { NPCPlugin, type PluginApi as NpcPluginApi } from "coco-cashu-plugin-npc";
import { privateKeyFromSeedWords } from "nostr-tools/nip06";
import { finalizeEvent, nip19, type EventTemplate } from "nostr-tools";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { mnemonicToSeedSync } from "@scure/bip39";
import type {
  CocodClient,
  CocodState,
  NpcAddress,
  NpcUsernameResult,
} from "./cocod-client";
import { cocoLogger, logger } from "../../utils/logger";
import {
  legacyCocodPidPath,
  legacyCocodSocketPath,
  walletDir as defaultWalletDir,
  walletPidPath as defaultWalletPidPath,
} from "./paths";

const NPC_DEFAULT_BASE_URL = "https://npubx.cash";

const STALE_SOCKET_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOENT",
  // Bun's Unix-socket fetch error for an abandoned socket inode.
  "FailedToOpenSocket",
]);

type UnixRequestInit = RequestInit & { unix: string };
type LegacyCocodFetch = (
  input: string | URL | Request,
  init: UnixRequestInit,
) => Promise<Response>;

export interface LegacyCocodGuardOptions {
  socketPath?: string;
  pidFilePath?: string;
  pathExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  isProcessRunning?: (pid: number) => boolean;
  /** PID owned by the caller's already-acquired legacy exclusion lock. */
  ignorePid?: number;
  fetchImpl?: LegacyCocodFetch;
  timeoutMs?: number;
}

export interface LegacyCocodPidClaimOptions {
  pidFilePath?: string;
  pid?: number;
  openExclusive?: (path: string) => number;
  writePid?: (fd: number, pid: number) => void;
  closeFile?: (fd: number) => void;
  readFile?: (path: string) => string;
  removeFile?: (path: string) => void;
  isProcessRunning?: (pid: number) => boolean;
}

export interface LegacyCocodStopOptions {
  socketPath?: string;
  pidFilePath?: string;
  pathExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  isProcessRunning?: (pid: number) => boolean;
  fetchImpl?: LegacyCocodFetch;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /** Total time to wait for cocod to exit after SIGTERM. */
  timeoutMs?: number;
  /** Interval between exit checks. */
  pollIntervalMs?: number;
  /** Timeout for identifying cocod through its Unix socket. */
  socketTimeoutMs?: number;
}

interface CocodConfig {
  mnemonic: string;
  encrypted: boolean;
  defaultMintUrl?: string;
}

const STARTUP_LOG_PREFIX = "[routstrd:start]";
export const DEFAULT_MINT_URL = "https://mint.cubabitcoin.org";

function startupProgress(message: string): void {
  logger.info(message);
  // The daemon is detached and stdout is captured by start-daemon.ts. The
  // prefix lets the CLI surface only safe, user-facing startup progress while
  // the full diagnostic stream remains in the normal log file.
  console.log(`${STARTUP_LOG_PREFIX} ${message}`);
}

const SAFE_COCO_LOG_FIELDS = new Set([
  "module",
  "mintUrl",
  "operationId",
  "quoteId",
  "state",
  "count",
  "total",
  "filterCount",
  "subId",
  "initOperations",
  "executingOperations",
  "pendingOperations",
  "rollingBackOperations",
  "orphanedReservations",
]);

function safeCocoMetadata(values: unknown[]): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, fieldValue] of Object.entries(value)) {
      if (SAFE_COCO_LOG_FIELDS.has(key)) safe[key] = fieldValue;
    }
  }
  return safe;
}

function createCocoLogger(bindings: Record<string, unknown> = {}): CocoLogger {
  const write = (
    level: "error" | "warn" | "info" | "debug",
    message: string,
    meta: unknown[],
  ) => {
    // Coco diagnostics may contain proof secrets or encoded tokens. Keep only
    // an explicit metadata allowlist; startup counts and operation IDs remain
    // useful without copying wallet material into routstrd's logs. Written to
    // ~/.routstrd/coco-logs/ so wallet-engine noise stays out of the main logs.
    const metadata = safeCocoMetadata([bindings, ...meta]);
    cocoLogger[level](
      `[coco] ${message}`,
      ...(Object.keys(metadata).length > 0 ? [metadata] : []),
    );
  };

  return {
    error: (message, ...meta) => write("error", message, meta),
    warn: (message, ...meta) => write("warn", message, meta),
    info: (message, ...meta) => write("info", message, meta),
    debug: (message, ...meta) => write("debug", message, meta),
    log: (level, message, ...meta) => write(level, message, meta),
    child: (childBindings) =>
      createCocoLogger({ ...bindings, ...childBindings }),
  };
}

function loadConfig(configFile: string): CocodConfig {
  if (!existsSync(configFile)) {
    throw new Error(
      `Config file not found at ${configFile}. Run 'routstrd onboard' first.`,
    );
  }
  const config = JSON.parse(readFileSync(configFile, "utf-8")) as CocodConfig;
  if (config.encrypted) {
    throw new Error(
      "Encrypted wallets are not supported yet. Please use an unencrypted wallet.",
    );
  }
  return config;
}

function saveConfig(config: CocodConfig, configFile: string): void {
  const temporaryFile = `${configFile}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryFile, JSON.stringify(config, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryFile, configFile);
  } catch (error) {
    try {
      unlinkSync(temporaryFile);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function hasErrorCode(error: unknown, codes: Set<string>): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();

  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && codes.has(candidate.code)) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}

/**
 * Refuse to open coco.db while the legacy cocod daemon owns its Unix socket.
 * Two independent wallet engines must never operate on the same proof database.
 *
 * A socket left behind after a crash is safe to ignore only when connecting
 * fails with ENOENT or ECONNREFUSED. Other probe failures are treated as unsafe
 * because they do not prove that cocod has stopped.
 */
export async function assertLegacyCocodNotRunning(
  options: LegacyCocodGuardOptions = {},
): Promise<void> {
  const socketPath = options.socketPath || legacyCocodSocketPath();
  const pidFilePath = options.pidFilePath || legacyCocodPidPath();
  const pathExists = options.pathExists || existsSync;
  const readFile = options.readFile || ((path) => readFileSync(path, "utf-8"));
  const isProcessRunning = options.isProcessRunning || defaultIsProcessRunning;

  const getRunningLegacyPid = (): number | null => {
    if (!pathExists(pidFilePath)) return null;

    try {
      const pid = Number.parseInt(readFile(pidFilePath).trim(), 10);
      return Number.isInteger(pid) &&
        pid > 0 &&
        pid !== options.ignorePid &&
        isProcessRunning(pid)
        ? pid
        : null;
    } catch {
      // An unreadable or malformed PID file does not prove that cocod is alive;
      // the socket probe below remains the authoritative fallback.
      return null;
    }
  };

  const runningPid = getRunningLegacyPid();
  if (runningPid !== null) {
    throw new Error(
      `Legacy cocod daemon is still running with PID ${runningPid}. ` +
        "Refusing to open the wallet database because cocod and coco-core cannot safely use it at the same time. " +
        `Run 'cocod stop' or 'kill ${runningPid}' and try again.`,
    );
  }

  if (!pathExists(socketPath)) return;

  const fetchImpl = options.fetchImpl || (fetch as LegacyCocodFetch);
  const timeoutMs = options.timeoutMs ?? 1_000;

  try {
    const response = await fetchImpl("http://localhost/ping", {
      unix: socketPath,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
  } catch (error) {
    if (hasErrorCode(error, STALE_SOCKET_ERROR_CODES)) {
      // Recheck after the failed probe in case cocod started concurrently.
      const newlyRunningPid = getRunningLegacyPid();
      if (newlyRunningPid === null) {
        logger.debug(`Ignoring stale legacy cocod socket at ${socketPath}`);
        return;
      }

      throw new Error(
        `Legacy cocod daemon is still running with PID ${newlyRunningPid}. ` +
          "Refusing to open the wallet database because cocod and coco-core cannot safely use it at the same time. " +
          `Run 'cocod stop' or 'kill ${newlyRunningPid}' and try again.`,
        { cause: error },
      );
    }

    throw new Error(
      `Cannot verify whether the legacy cocod daemon has stopped at ${socketPath}. ` +
        "Refusing to open the wallet database to prevent concurrent access. " +
        "Run 'cocod stop', verify the daemon has exited, and try again.",
      { cause: error },
    );
  }

  throw new Error(
    `Legacy cocod daemon is still running at ${socketPath}. ` +
      "Refusing to open the wallet database because cocod and coco-core cannot safely use it at the same time. " +
      "Run 'cocod stop' and try again.",
  );
}

/**
 * Gracefully stop a legacy cocod daemon that is still running, so the new
 * in-process coco wallet can safely open the shared database.
 *
 * Sends SIGTERM to the PID recorded in cocod's PID file, then polls until the
 * process exits and the PID file is removed (cocod cleans up both on graceful
 * shutdown). On timeout it refuses rather than escalating to SIGKILL, because
 * killing a wallet engine mid-proof-recovery risks corrupting coco.db — the
 * exact failure the guard exists to prevent.
 */
export async function stopLegacyCocod(
  options: LegacyCocodStopOptions = {},
): Promise<void> {
  const socketPath = options.socketPath || legacyCocodSocketPath();
  const pidFilePath = options.pidFilePath || legacyCocodPidPath();
  const pathExists = options.pathExists || existsSync;
  const readFile =
    options.readFile || ((path: string) => readFileSync(path, "utf-8"));
  const isProcessRunning = options.isProcessRunning || defaultIsProcessRunning;
  const fetchImpl = options.fetchImpl || (fetch as LegacyCocodFetch);
  const killProcess =
    options.killProcess || ((pid, signal) => process.kill(pid, signal));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const socketTimeoutMs = options.socketTimeoutMs ?? 1_000;

  const readPid = (): number | null => {
    if (!pathExists(pidFilePath)) return null;
    try {
      const pid = Number.parseInt(readFile(pidFilePath).trim(), 10);
      return Number.isInteger(pid) && pid > 0 && isProcessRunning(pid)
        ? pid
        : null;
    } catch {
      return null;
    }
  };

  const pid = readPid();
  if (pid === null) {
    logger.debug(
      "stopLegacyCocod: no running legacy cocod found, nothing to stop.",
    );
    return;
  }

  // routstrd intentionally writes its own PID to cocod.pid while the in-process
  // wallet is open. Never identify the owner from the shared PID file alone:
  // only a process responding through cocod's Unix socket is safe to terminate.
  if (!pathExists(socketPath)) {
    logger.debug(
      `PID ${pid} owns ${pidFilePath}, but no legacy cocod socket exists; leaving it running.`,
    );
    return;
  }

  try {
    const response = await fetchImpl("http://localhost/ping", {
      unix: socketPath,
      signal: AbortSignal.timeout(socketTimeoutMs),
    });
    await response.body?.cancel();
  } catch (error) {
    if (hasErrorCode(error, STALE_SOCKET_ERROR_CODES)) {
      logger.debug(
        `PID ${pid} owns ${pidFilePath}, but the legacy cocod socket is stale; leaving it running.`,
      );
      return;
    }

    throw new Error(
      `Cannot verify whether PID ${pid} is the legacy cocod daemon at ${socketPath}. ` +
        "Refusing to stop an unidentified process.",
      { cause: error },
    );
  }

  logger.log(`Stopping legacy cocod daemon (PID ${pid})…`);
  killProcess(pid, "SIGTERM");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (!isProcessRunning(pid) || readPid() !== pid) {
      logger.log(`Legacy cocod daemon (PID ${pid}) stopped.`);
      return;
    }
  }

  throw new Error(
    `Legacy cocod daemon (PID ${pid}) did not stop within ${Math.round(
      timeoutMs / 1000,
    )}s of SIGTERM. ` + `Run 'kill ${pid}' and try again.`,
  );
}

/**
 * Atomically claim cocod's PID file for the lifetime of the in-process wallet.
 * Legacy cocod checks this same file before opening coco.db, so a live routstrd
 * owner prevents cocod from starting after the initial socket/PID probe.
 */
export function claimLegacyCocodPidFile(
  options: LegacyCocodPidClaimOptions = {},
): () => void {
  return claimPidFile({
    ...options,
    pidFilePath: options.pidFilePath || legacyCocodPidPath(),
  });
}

function claimPidFile(options: LegacyCocodPidClaimOptions & { pidFilePath: string }): () => void {
  const pidFilePath = options.pidFilePath;
  const pid = options.pid ?? process.pid;
  const openExclusive =
    options.openExclusive || ((path: string) => openSync(path, "wx", 0o600));
  const writePid =
    options.writePid ||
    ((fd: number, ownerPid: number) => writeFileSync(fd, String(ownerPid)));
  const closeFile = options.closeFile || closeSync;
  const readFile =
    options.readFile || ((path: string) => readFileSync(path, "utf-8"));
  const removeFile = options.removeFile || unlinkSync;
  const isProcessRunning = options.isProcessRunning || defaultIsProcessRunning;

  let fd: number;
  try {
    fd = openExclusive(pidFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    // The earlier guard permits a dead PID file. Remove only a parseable,
    // confirmed-dead owner; an empty/malformed file may belong to a process
    // that has created the file but has not written its PID yet.
    let stalePid: number;
    try {
      stalePid = Number.parseInt(readFile(pidFilePath).trim(), 10);
    } catch {
      throw new Error(
        `Cannot claim the wallet process lock at ${pidFilePath}. ` +
          "Another cocod or routstrd process may be starting. Stop it and try again.",
        { cause: error },
      );
    }

    if (
      !Number.isInteger(stalePid) ||
      stalePid <= 0 ||
      isProcessRunning(stalePid)
    ) {
      throw new Error(
        `Cannot claim the wallet process lock at ${pidFilePath}. ` +
          "Another cocod or routstrd process may be starting. Stop it and try again.",
        { cause: error },
      );
    }

    try {
      removeFile(pidFilePath);
      fd = openExclusive(pidFilePath);
    } catch (retryError) {
      throw new Error(
        `Cannot claim the wallet process lock at ${pidFilePath}. ` +
          "Another cocod or routstrd process may be starting. Stop it and try again.",
        { cause: retryError },
      );
    }
  }

  try {
    writePid(fd, pid);
  } catch (error) {
    try {
      removeFile(pidFilePath);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  } finally {
    closeFile(fd);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;

    try {
      if (readFile(pidFilePath).trim() === String(pid)) {
        removeFile(pidFilePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          `Failed to release wallet process lock at ${pidFilePath}:`,
          error,
        );
      }
    }
  };
}

export interface CreateCocoClientOptions {
  /** Override the canonical wallet data directory. */
  walletDir?: string;
  /** Deprecated alias retained for existing callers during migration. */
  configDir?: string;
  /** Override the in-process wallet lock path. */
  walletPidPath?: string;
  /** Override legacy external-cocod coordination paths. */
  legacySocketPath?: string;
  legacyPidPath?: string;
  /** Set to false to skip NPC (npubx.cash) plugin registration. Default: true. */
  enableNpc?: boolean;
  /** NPC server base URL. Default: https://npubx.cash */
  npcBaseUrl?: string;
}

export async function createCocoClient(
  options: CreateCocoClientOptions = {},
): Promise<CocodClient> {
  const configDir = options.walletDir || options.configDir || defaultWalletDir();
  const configFile = join(configDir, "config.json");
  const dbPath = join(configDir, "coco.db");
  const walletPidFile =
    options.walletPidPath ||
    (options.walletDir || options.configDir
      ? join(configDir, "wallet.pid")
      : defaultWalletPidPath());
  const legacySocket = options.legacySocketPath || legacyCocodSocketPath();
  const legacyPidFile = options.legacyPidPath || legacyCocodPidPath();
  const npcBaseUrl = options.npcBaseUrl || NPC_DEFAULT_BASE_URL;
  const npcAddressDomain = new URL(npcBaseUrl).host;

  await assertLegacyCocodNotRunning({
    socketPath: legacySocket,
    pidFilePath: legacyPidFile,
  });
  // The canonical wallet directory is created by initialization/migration.
  // Keep a legacy PID claim as an exclusion fence for old cocod binaries.
  mkdirSync(dirname(legacyPidFile), { recursive: true, mode: 0o700 });
  const releaseWalletPidClaim = claimPidFile({ pidFilePath: walletPidFile });
  let releaseLegacyPidClaim: () => void;
  try {
    releaseLegacyPidClaim = claimLegacyCocodPidFile({
      pidFilePath: legacyPidFile,
    });
  } catch (error) {
    releaseWalletPidClaim();
    throw error;
  }

  let database: Database | undefined;
  let coco: Awaited<ReturnType<typeof initializeCoco>> | undefined;
  let walletConfig = loadConfig(configFile);

  try {
    startupProgress("Opening Cashu wallet database...");

    // Read and validate the existing cocod config during startup rather than
    // deferring failure until coco-core first needs wallet key material.
    const mnemonic = walletConfig.mnemonic;
    const seed = mnemonicToSeedSync(mnemonic);
    database = new Database(dbPath);
    const repo = new SqliteRepositories({ database });
    await repo.init();

    const [pendingSends, inflightProofs, pendingMints] = await Promise.all([
      repo.sendOperationRepository.getPending(),
      repo.proofRepository.getInflightProofs(),
      repo.mintOperationRepository.getPending(),
    ]);
    const recoveryCount =
      pendingSends.length + inflightProofs.length + pendingMints.length;
    if (recoveryCount > 0) {
      startupProgress(
        `Recovering wallet state: ${pendingSends.length} pending sends, ` +
          `${inflightProofs.length} in-flight proofs, ${pendingMints.length} pending mints. ` +
          "This may take a few minutes while Cashu mints are contacted.",
      );
    } else {
      startupProgress("Initializing Cashu wallet...");
    }

    coco = await initializeCoco({
      repo,
      seedGetter: async () => seed,
      logger: createCocoLogger(),
    });

    const trustedMints = await coco.mint.getAllTrustedMints();
    const configuredDefault = walletConfig.defaultMintUrl;
    const defaultMintUrl = normalizeMintUrl(
      configuredDefault || trustedMints[0]?.mintUrl || DEFAULT_MINT_URL,
    );

    if (!trustedMints.some((mint) => mint.mintUrl === defaultMintUrl)) {
      startupProgress(`Adding default mint: ${defaultMintUrl}`);
      await coco.mint.addMint(defaultMintUrl, { trusted: true });
    }

    // Persist only after the mint was successfully fetched and trusted. A failed
    // network request must not leave config pointing at an unusable default.
    walletConfig.defaultMintUrl = defaultMintUrl;
    if (configuredDefault !== defaultMintUrl) {
      saveConfig(walletConfig, configFile);
    }

    if (options.enableNpc !== false) {
      startupProgress("Registering NPC (npubx.cash) plugin...");
      // NPC authenticates with a Nostr key derived from the same wallet seed
      // (NIP-06). The signer only produces JWT auth events for the NPC
      // server; it never signs anything that moves funds by itself.
      const npcSecretKey = privateKeyFromSeedWords(mnemonic);
      const npcSigner = async (template: EventTemplate) =>
        finalizeEvent(template, npcSecretKey);
      const npcPlugin = new NPCPlugin(npcBaseUrl, npcSigner, {
        useWebsocket: true,
        logger: createCocoLogger({ module: "npc" }),
      });
      // coco-cashu-plugin-npc implements the plugin contract from the
      // coco-cashu-core package while routstrd runs the equivalent
      // @cashu/coco-core build. The plugin host API is structurally identical
      // in both (verified: mintService.addMintByUrl,
      // mintOperationService.importQuote/getOperationByQuote), so this cast
      // only bridges the duplicate package names, not a real API gap.
      coco.use(npcPlugin as unknown as CocoPlugin);
    }

    startupProgress("Cashu wallet ready.");
  } catch (error) {
    database?.close();
    releaseLegacyPidClaim();
    releaseWalletPidClaim();
    throw error;
  }

  const npcApi = (): NpcPluginApi => {
    // The plugin augments coco-cashu-core's PluginExtensions; the equivalent
    // registration lives on manager.ext here. Guard for enableNpc=false.
    const api = coco
      ? (coco.ext as { npc?: NpcPluginApi }).npc
      : undefined;
    if (!api) {
      throw new Error("NPC plugin is not enabled for this wallet.");
    }
    return api;
  };

  let disposed = false;
  return {
    async ping(): Promise<boolean> {
      try {
        await coco.wallet.balances.total();
        return true;
      } catch {
        return false;
      }
    },

    async getStatus(): Promise<CocodState> {
      try {
        await coco.wallet.balances.total();
        return "UNLOCKED";
      } catch {
        return "ERROR";
      }
    },

    async unlock(_passphrase: string): Promise<string> {
      // coco-core does not support passphrase locking.
      // Wallet access is controlled by ~/.routstrd/wallet/config.json.
      return "wallet does not require unlocking";
    },

    async getBalances(): Promise<Record<string, number>> {
      const byMint = await coco.wallet.balances.byMint();
      return Object.fromEntries(
        Object.entries(byMint).map(([mintUrl, snapshot]) => [
          mintUrl,
          snapshot.spendable,
        ]),
      );
    },

    async receiveCashu(token: string): Promise<string> {
      await coco.wallet.receive(token);
      return "Token received successfully";
    },

    async receiveBolt11(amount: number, mintUrl?: string): Promise<string> {
      const targetMint = mintUrl || walletConfig.defaultMintUrl;
      if (!targetMint) {
        throw new Error("No trusted mint available for Lightning invoice");
      }
      const op = await coco.ops.mint.prepare({
        mintUrl: targetMint,
        amount,
        method: "bolt11",
      });
      if (!("request" in op)) {
        throw new Error("mint prepare did not return a payment request");
      }
      return op.request as string;
    },

    async sendCashu(amount: number, mintUrl?: string): Promise<string> {
      const targetMint = mintUrl || walletConfig.defaultMintUrl;
      if (!targetMint) {
        throw new Error("No trusted mint available for sending");
      }
      const prepared = await coco.ops.send.prepare({
        mintUrl: targetMint,
        amount,
      });
      const { token } = await coco.ops.send.execute(prepared.id);
      return getEncodedToken(token);
    },

    async sendBolt11(invoice: string, mintUrl?: string): Promise<string> {
      const targetMint = mintUrl || walletConfig.defaultMintUrl;
      if (!targetMint) {
        throw new Error("No trusted mint available for Lightning payment");
      }
      const prepared = await coco.ops.melt.prepare({
        mintUrl: targetMint,
        method: "bolt11",
        methodData: { invoice },
      });
      await coco.ops.melt.execute(prepared.id);
      return "Payment sent successfully";
    },

    async listMints(): Promise<string[]> {
      const mints = await coco.mint.getAllTrustedMints();
      return mints.map((m) => m.mintUrl);
    },

    async addMint(url: string): Promise<string> {
      const mintUrl = normalizeMintUrl(url);
      await coco.mint.addMint(mintUrl, { trusted: true });
      return `Mint ${mintUrl} added successfully`;
    },

    async getMintInfo(url: string): Promise<unknown> {
      return coco.mint.getMintInfo(normalizeMintUrl(url));
    },

    async getDefaultMint(): Promise<string | null> {
      return walletConfig.defaultMintUrl || null;
    },

    async setDefaultMint(url: string): Promise<string> {
      const mintUrl = normalizeMintUrl(url);
      const trustedMints = await coco.mint.getAllTrustedMints();
      if (!trustedMints.some((mint) => mint.mintUrl === mintUrl)) {
        await coco.mint.addMint(mintUrl, { trusted: true });
      }

      walletConfig.defaultMintUrl = mintUrl;
      saveConfig(walletConfig, configFile);
      return `Default mint set to ${mintUrl}`;
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        await coco.dispose();
      } finally {
        try {
          database.close();
        } finally {
          releaseLegacyPidClaim();
          releaseWalletPidClaim();
        }
      }
    },

    async getHistory(offset?: number, limit?: number): Promise<HistoryEntry[]> {
      return coco.history.getPaginatedHistory(offset, limit);
    },

    async getNpcAddress(): Promise<NpcAddress> {
      const info = await npcApi().getInfo();
      const name =
        typeof info?.name === "string" && info.name.trim()
          ? info.name.trim()
          : undefined;
      const localPart = name ?? nip19.npubEncode(info.pubkey);
      return {
        address: `${localPart}@${npcAddressDomain}`,
        ...(name ? { name } : {}),
        pubkey: info.pubkey,
      };
    },

    async setNpcUsername(
      username: string,
      confirm?: boolean,
    ): Promise<NpcUsernameResult> {
      const result = await npcApi().setUsername(username, confirm === true);
      if (result.success) {
        return { success: true };
      }
      return {
        success: false,
        paymentRequest:
          result.pr as NpcUsernameResult["paymentRequest"],
      };
    },

    async syncNpc(): Promise<void> {
      await npcApi().sync();
    },
  };
}
