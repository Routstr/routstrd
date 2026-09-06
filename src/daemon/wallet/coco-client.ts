import {
  Manager,
  getEncodedToken,
  normalizeMintUrl,
} from "@cashu/coco-core";
import type {
  HistoryEntry,
  ReceiveOperation,
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
  WalletCleanupOptions,
  WalletCleanupResult,
  WalletRecoveryProgress,
} from "./cocod-client";
import { selectCleanupOperations } from "./cleanup";
import {
  clearInterruptedReceiveReservations,
  deleteReceiveTokenReservation,
  getReceiveReconcileBackup,
  initReceiveDedupSchema,
  listProcessingReceiveTokens,
  receiveInputFingerprint,
  reconcileExecutingReceives,
  releaseReceiveToken,
  reserveReceiveToken,
  setReceiveReconcileBackup,
  updateReceiveToken,
  type ReceiveReconcileSource,
} from "./receive-dedup";
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
  pathExists?: (path: string) => boolean;
  fetchImpl?: LegacyCocodFetch;
  timeoutMs?: number;
}

export interface LegacyCocodPidClaimOptions {
  pidFilePath?: string;
  pid?: number;
  /** Human-readable lock name used in contention errors. */
  label?: string;
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

// Set only while the background wallet recovery sweeps are running. While set,
// coco logger messages that indicate a stalled/failed per-mint check are
// forwarded to the startup stream (see createCocoLogger).
let surfacingRecoveryProgress = false;

// These fire once per operation when a mint is unreachable or otherwise fails
// to reconcile. They are the only per-mint signal coco emits, and they happen
// exactly when recovery is slow.
const RECOVERY_STALL_MARKERS = new Map<string, string>([
  ["SendOperationService\u0000Could not reach mint for recovery, will retry later", "Send recovery: mint unreachable"],
  ["ReceiveOperationService\u0000Could not reach mint for receive recovery, will retry later", "Receive recovery: mint unreachable"],
  ["MintOperationService\u0000Failed to reconcile stale pending mint operation", "Mint recovery: pending operation check failed"],
]);

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

    if (surfacingRecoveryProgress) {
      const module = typeof bindings.module === "string" ? bindings.module : undefined;
      if (module) {
        const stall = RECOVERY_STALL_MARKERS.get(`${module}\u0000${message}`);
        if (stall) {
          const mintUrl =
            typeof metadata.mintUrl === "string" ? metadata.mintUrl : undefined;
          startupProgress(mintUrl ? `${stall} (${mintUrl})` : stall);
        }
      }
    }

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

export function isZombieProcess(
  pid: number,
  readFile: (path: string) => string = (path) =>
    readFileSync(path, "utf-8"),
): boolean {
  try {
    // Linux exposes zombie state as the character following the final `)` in
    // /proc/<pid>/stat. Use the final parenthesis because process names may
    // themselves contain spaces or parentheses. Other platforms simply fall
    // back to process.kill(pid, 0) below.
    const stat = readFile(`/proc/${pid}/stat`);
    const commandEnd = stat.lastIndexOf(")");
    return commandEnd >= 0 && stat.charAt(commandEnd + 2) === "Z";
  } catch {
    return false;
  }
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }

  // kill(pid, 0) also succeeds for dead-but-unreaped processes. Zombies hold
  // no database or socket resources, so treating them as dead allows stale
  // wallet locks to be reclaimed (notably under non-reaping Docker PID 1s).
  return !isZombieProcess(pid);
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
 * Refuse to open coco.db while a daemon answers on legacy cocod's Unix socket.
 * Two independent wallet engines must never operate on the same proof database.
 *
 * cocod.pid is deliberately shared: routstrd writes its own PID there while
 * the in-process wallet is open, fencing old cocod binaries from starting. A
 * live PID in that file therefore cannot identify cocod. Socket responsiveness
 * is the authoritative identity check; the atomic PID-file claim below closes
 * the race when cocod is still starting and has not opened its socket yet.
 *
 * A socket left behind after a crash is safe to ignore only when connecting
 * fails with ENOENT or ECONNREFUSED. Other probe failures are treated as unsafe
 * because they do not prove that cocod has stopped.
 */
export async function assertLegacyCocodNotRunning(
  options: LegacyCocodGuardOptions = {},
): Promise<void> {
  const socketPath = options.socketPath || legacyCocodSocketPath();
  const pathExists = options.pathExists || existsSync;

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
      logger.debug(`Ignoring stale legacy cocod socket at ${socketPath}`);
      return;
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
    label: options.label || "legacy cocod exclusion lock",
  });
}

function claimPidFile(options: LegacyCocodPidClaimOptions & { pidFilePath: string }): () => void {
  const pidFilePath = options.pidFilePath;
  const pid = options.pid ?? process.pid;
  const label = options.label || "wallet process lock";
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
        `Cannot claim the ${label} at ${pidFilePath}. ` +
          "Another cocod or routstrd process may be starting. Stop it and try again.",
        { cause: error },
      );
    }

    if (
      !Number.isInteger(stalePid) ||
      stalePid <= 0 ||
      isProcessRunning(stalePid)
    ) {
      const ownerMessage =
        Number.isInteger(stalePid) && stalePid > 0
          ? `PID ${stalePid} is still running and holds it. ` +
            `Stop that process first ('routstrd stop' or 'kill ${stalePid}').`
          : "Another cocod or routstrd process may be starting. Stop it and try again.";
      throw new Error(
        `Cannot claim the ${label} at ${pidFilePath}: ${ownerMessage}`,
        { cause: error },
      );
    }

    try {
      removeFile(pidFilePath);
      fd = openExclusive(pidFilePath);
    } catch (retryError) {
      throw new Error(
        `Cannot claim the ${label} at ${pidFilePath}. ` +
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
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);

    try {
      if (readFile(pidFilePath).trim() === String(pid)) {
        removeFile(pidFilePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          `Failed to release ${label} at ${pidFilePath}:`,
          error,
        );
      }
    }
  };

  // process.exit() and natural shutdown still run synchronous exit handlers.
  // This prevents migration or startup failures from stranding our PID files.
  process.once("exit", release);
  return release;
}

/**
 * Minimal structural view of coco-core's MintOperationService.
 * The service is private on the exported Manager class, so the in-process
 * client reaches it through this narrow cast. Both methods reload the latest
 * persisted row before mutating anything, so a bare operation id is enough.
 */
interface MintOperationServiceCleanup {
  failPendingOperation(
    op: { id: string },
    terminalFailure: { reason: string; retryable?: boolean; observedAt: number },
  ): Promise<unknown>;
  /**
   * Ask the mint for a pending quote's current state and persist the
   * observation. "waiting" means the mint still reports the quote as unpaid.
   */
  observePendingOperation(
    operationId: string,
  ): Promise<{ category: "waiting" | "ready" | "completed" | "terminal" }>;
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

/**
 * Build a usable coco Manager without running the blocking recovery sweeps.
 *
 * This replicates `initializeCoco()` up to (but not including) the send/melt/
 * receive/mint recovery passes, so the daemon can serve wallet reads while
 * recovery proceeds in the background.
 */
function constructCocoManager(
  repo: SqliteRepositories,
  seed: Uint8Array,
): Manager {
  return new Manager(repo, async () => seed, createCocoLogger());
}

async function enableCocoManager(coco: Manager): Promise<void> {
  await coco.initPlugins();
  await coco.reconcileLegacyMintQuotes();
  await coco.enableMintOperationWatcher();
  await coco.enableProofStateWatcher();
  await coco.enableMintOperationProcessor();
}

/**
 * Shared wall-clock budget for checking expired mint quotes with their mints
 * during background recovery. coco-core issues mint requests without a
 * timeout, so a hung mint could otherwise stall this phase (and with it the
 * recovery promise that gates value-moving operations) far longer than this.
 */
const EXPIRED_MINT_OBSERVATION_DEADLINE_MS = 15_000;

/** Rejects when `timeoutMs` elapses before `promise` settles. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Timed out contacting mint")),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Structural subset of coco's Manager used by expired-quote settlement. */
export interface ExpiredMintQuoteSource {
  ops: {
    mint: {
      listPending(): Promise<
        Array<{
          id: string;
          mintUrl: string;
          quoteId?: string;
          state: string;
          /** Quote expiry in epoch seconds. */
          expiry: number;
          updatedAt: number;
          lastObservedRemoteState?: string;
        }>
      >;
    };
  };
  mintOperationService: MintOperationServiceCleanup;
}

export interface ExpiredMintSettlement {
  /** Quotes their mint confirmed as UNPAID, failed locally. */
  failed: number;
  /** Quotes observed as PAID/ISSUED, left for mint recovery to finalize. */
  leftForRecovery: number;
  /** Quotes whose mint could not be checked in time, left pending. */
  unobserved: number;
}

/**
 * Settle expired pending mint quotes before the mint recovery sweep runs.
 *
 * An expired bolt11 invoice can never be paid again, so a quote the mint
 * still reports as UNPAID is guaranteed never to be issued and is failed
 * locally. That local fail is what keeps coco-core's mint recovery sweep
 * quick: the sweep treats UNPAID as "waiting" and would otherwise re-contact
 * every dead quote's mint on every startup.
 *
 * The observation round is what makes the local fail safe: a quote can have
 * been paid before expiry while the daemon was down, leaving no local
 * observation behind. Failing such a quote without asking the mint would
 * strand the paid funds, because failed operations are skipped by recovery.
 * Asking the mint first closes that hole: PAID/ISSUED quotes are left for
 * the sweep to finalize, and quotes whose mint is unreachable or too slow
 * are left pending so a later startup can still recover them.
 */
export async function settleExpiredMintQuotes(
  source: ExpiredMintQuoteSource,
  nowMs: number,
  deadlineMs: number = EXPIRED_MINT_OBSERVATION_DEADLINE_MS,
): Promise<ExpiredMintSettlement> {
  const pendingMints = await source.ops.mint.listPending();
  const selection = selectCleanupOperations({
    mints: pendingMints,
    sends: [],
    melts: [],
    nowMs,
    minAgeMs: 0,
  });

  const settlement: ExpiredMintSettlement = {
    failed: 0,
    leftForRecovery: 0,
    unobserved: 0,
  };
  const candidates = selection.mintsToFail;
  if (candidates.length === 0) return settlement;

  const startedAt = Date.now();
  for (const op of candidates) {
    const remainingMs = deadlineMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      const skipped =
        candidates.length -
        settlement.failed -
        settlement.leftForRecovery -
        settlement.unobserved;
      settlement.unobserved += skipped;
      startupProgress(
        `Expired mint quote check budget exhausted; ${skipped} quote(s) left for mint recovery.`,
      );
      break;
    }

    try {
      const result = await withTimeout(
        source.mintOperationService.observePendingOperation(op.id),
        remainingMs,
      );
      if (result.category === "waiting") {
        // The mint confirms the expired quote is still unpaid: it can never
        // be issued now, so failing it locally cannot strand funds.
        await source.mintOperationService.failPendingOperation(
          { id: op.id },
          {
            reason: "Expired mint quote confirmed unpaid by mint",
            retryable: false,
            observedAt: Date.now(),
          },
        );
        settlement.failed++;
      } else {
        // PAID/ISSUED (or terminally failed) at the mint: normal recovery
        // must see this quote so paid proofs get claimed.
        settlement.leftForRecovery++;
        const observed =
          result.category === "ready"
            ? "was paid at the mint"
            : result.category === "completed"
              ? "was already issued at the mint"
              : "failed terminally at the mint";
        startupProgress(
          `Expired mint quote ${op.quoteId ?? op.id} at ${op.mintUrl} ${observed}; leaving it for mint recovery.`,
        );
      }
    } catch (error) {
      // Mint unreachable, too slow, or the quote unknown to it: leave the
      // operation pending so a later startup can still recover it.
      settlement.unobserved++;
      logger.warn("Could not check expired mint quote; leaving it pending", {
        operationId: op.id,
        mintUrl: op.mintUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return settlement;
}

interface ReceiveRecoveryInternals {
  receiveOperationService: {
    checkProofStatesWithMint(
      mintUrl: string,
      proofs: Array<{ secret: string }>,
    ): Promise<Array<{ state: string }>>;
    hasSavedOutputs(operation: unknown): Promise<boolean>;
    markAsRolledBack(operation: unknown, error: string): Promise<unknown>;
  };
  mintAdapter: {
    getCashuMint(mintUrl: string): {
      restore(input: { outputs: Array<{ amount: number; id: string; B_: string }> }): Promise<{
        outputs: Array<{ B_: string }>;
      }>;
    };
  };
}

async function reconcileDuplicateReceiveOperations(
  coco: Manager,
  repo: SqliteRepositories,
): Promise<Awaited<ReturnType<typeof reconcileExecutingReceives>>> {
  const internals = coco as unknown as ReceiveRecoveryInternals;
  const unavailableMints = new Set<string>();
  const deadline = Date.now() + 45_000;
  const ensureMintBudget = (mintUrl: string): void => {
    if (Date.now() >= deadline) throw new Error("Receive cleanup time budget exhausted");
    if (unavailableMints.has(mintUrl)) throw new Error("Mint already failed receive cleanup");
  };
  const markMintFailure = (mintUrl: string, error: unknown): never => {
    unavailableMints.add(mintUrl);
    throw error;
  };
  const source: ReceiveReconcileSource = {
    listExecuting: () => repo.receiveOperationRepository.getByState("executing"),
    checkProofStates: async (operation) => {
      ensureMintBudget(operation.mintUrl);
      try {
        return await withTimeout(
          internals.receiveOperationService.checkProofStatesWithMint(
            operation.mintUrl,
            operation.inputProofs,
          ),
          Math.min(15_000, Math.max(1, deadline - Date.now())),
        );
      } catch (error) {
        return markMintFailure(operation.mintUrl, error);
      }
    },
    restoreOutputs: async (mintUrl, outputs) => {
      ensureMintBudget(mintUrl);
      // Probe deterministic outputs in bounded batches. The Cashu restore
      // response echoes only blinded messages with stored signatures, which
      // identifies the owning operation. Coco later performs the real proof
      // recovery for the retained operation.
      const restored: Array<{ B_: string }> = [];
      const mint = internals.mintAdapter.getCashuMint(mintUrl);
      for (let index = 0; index < outputs.length; index += 300) {
        try {
          const response = await withTimeout(
            mint.restore({ outputs: outputs.slice(index, index + 300) }),
            Math.min(15_000, Math.max(1, deadline - Date.now())),
          );
          restored.push(...response.outputs);
        } catch (error) {
          return markMintFailure(mintUrl, error);
        }
      }
      return restored;
    },
    hasSavedOutputs: (operation) =>
      internals.receiveOperationService.hasSavedOutputs(operation),
    rollBack: async (operation, reason) => {
      await internals.receiveOperationService.markAsRolledBack(operation, reason);
    },
  };
  return reconcileExecutingReceives(source);
}

interface RecoveryPhaseProgress {
  phase: string;
  failedMintQuotes: number;
}

/**
 * Run the wallet recovery sweeps in order, reporting phase changes.
 *
 * Expired mint quotes are settled first: quotes their mint confirms as unpaid
 * are failed locally so `recoverPendingMintOperations()` skips them, while
 * paid/issued and unreachable-mint quotes stay pending for the sweep.
 */
async function runWalletRecovery(
  coco: Manager,
  onProgress: (progress: RecoveryPhaseProgress) => void,
  receiveOperationIds?: string[],
): Promise<void> {
  surfacingRecoveryProgress = true;
  let failedMintQuotes = 0;
  try {
    onProgress({ phase: "Settling expired mint quotes", failedMintQuotes });
    const settlement = await settleExpiredMintQuotes(
      {
        ops: coco.ops,
        mintOperationService: (
          coco as unknown as {
            mintOperationService: MintOperationServiceCleanup;
          }
        ).mintOperationService,
      },
      Date.now(),
    );
    failedMintQuotes = settlement.failed;
    if (settlement.leftForRecovery > 0 || settlement.unobserved > 0) {
      startupProgress(
        `Expired mint quotes: ${settlement.failed} failed locally, ` +
          `${settlement.leftForRecovery} paid/issued (kept for recovery), ` +
          `${settlement.unobserved} unverifiable (kept pending).`,
      );
    }
    onProgress({ phase: "Settled expired mint quotes", failedMintQuotes });

    onProgress({ phase: "Send recovery", failedMintQuotes });
    await coco.ops.send.recovery.run();

    onProgress({ phase: "Melt recovery", failedMintQuotes });
    await coco.ops.melt.recovery.run();

    onProgress({ phase: "Receive recovery", failedMintQuotes });
    if (receiveOperationIds) {
      // The pre-check already classified every executing receive by unique
      // input set. Recover only the conclusive retained operations; unresolved
      // groups stay untouched instead of falling back to Coco 1's expensive
      // per-row sweep on this startup.
      for (const operationId of receiveOperationIds) {
        try {
          await withTimeout(coco.ops.receive.refresh(operationId), 15_000);
        } catch (error) {
          logger.warn("Targeted receive recovery did not complete", {
            operationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else {
      await coco.ops.receive.recovery.run();
    }

    onProgress({ phase: "Mint recovery", failedMintQuotes });
    await coco.recoverPendingMintOperations();

    onProgress({ phase: "done", failedMintQuotes });
  } finally {
    surfacingRecoveryProgress = false;
  }
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

  await assertLegacyCocodNotRunning({ socketPath: legacySocket });
  // The canonical wallet directory is created by initialization/migration.
  // Keep a legacy PID claim as an exclusion fence for old cocod binaries.
  mkdirSync(dirname(legacyPidFile), { recursive: true, mode: 0o700 });
  const releaseWalletPidClaim = claimPidFile({
    pidFilePath: walletPidFile,
    label: "routstrd wallet lock",
  });
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
  let coco: Manager | undefined;
  let findFinalizedReceiveSibling: (
    operation: ReceiveOperation | null,
  ) => Promise<string | null> = async () => null;
  let walletConfig = loadConfig(configFile);

  let recoveryPhase = "queued";
  let recoveryFailedMintQuotes = 0;
  let recoveryDone = false;
  let recoveryError: string | undefined;
  const recoveryCounts = {
    pendingSends: 0,
    inflightProofs: 0,
    pendingMints: 0,
  };
  let recoveryResolve: (() => void) | undefined;
  const recoveryPromise = new Promise<void>((resolve) => {
    recoveryResolve = resolve;
  });

  try {
    startupProgress("Opening Cashu wallet database...");

    // Read and validate the existing cocod config during startup rather than
    // deferring failure until coco-core first needs wallet key material.
    const mnemonic = walletConfig.mnemonic;
    const seed = mnemonicToSeedSync(mnemonic);
    database = new Database(dbPath);
    const repo = new SqliteRepositories({ database });
    await repo.init();
    initReceiveDedupSchema(database);
    const interruptedReservations = clearInterruptedReceiveReservations(database);
    if (interruptedReservations > 0) {
      logger.warn("Cleared interrupted receive reservations with no Coco operation", {
        count: interruptedReservations,
      });
    }

    const [pendingSends, inflightProofs, pendingMints] = await Promise.all([
      repo.sendOperationRepository.getPending(),
      repo.proofRepository.getInflightProofs(),
      repo.mintOperationRepository.getPending(),
    ]);
    recoveryCounts.pendingSends = pendingSends.length;
    recoveryCounts.inflightProofs = inflightProofs.length;
    recoveryCounts.pendingMints = pendingMints.length;
    const recoveryCount =
      recoveryCounts.pendingSends +
      recoveryCounts.inflightProofs +
      recoveryCounts.pendingMints;

    if (recoveryCount > 0) {
      startupProgress(
        `Recovering wallet state in background: ${recoveryCounts.pendingSends} pending sends, ` +
          `${recoveryCounts.inflightProofs} in-flight proofs, ${recoveryCounts.pendingMints} pending mints.`,
      );
    } else {
      startupProgress("Initializing Cashu wallet...");
    }

    // Construct Coco so the pre-recovery checker can reuse its mint adapter,
    // but do not enable watchers/processors until the backup and cleanup finish.
    coco = constructCocoManager(repo, seed);

    const executingReceives = await repo.receiveOperationRepository.getByState("executing");
    let receiveRecoveryOperationIds: string[] | undefined;
    if (executingReceives.length > 0) {
      startupProgress(
        `Checking ${executingReceives.length} unfinished Cashu receive operation(s) for duplicates...`,
      );
      const recordedBackup = getReceiveReconcileBackup(database);
      if (!recordedBackup || !existsSync(recordedBackup)) {
        const backupPath = `${dbPath}.pre-receive-reconcile-${Date.now()}`;
        database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
        setReceiveReconcileBackup(database, backupPath);
        startupProgress(`Created wallet backup before receive cleanup: ${backupPath}`);
      }
      const receiveReconcile = await reconcileDuplicateReceiveOperations(coco, repo);
      receiveRecoveryOperationIds = receiveReconcile.recoveryOperationIds;
      startupProgress(
        `Receive cleanup: ${receiveReconcile.executing} operation(s), ` +
          `${receiveReconcile.uniqueGroups} unique input set(s), ` +
          `${receiveReconcile.rolledBack} stale duplicate(s) retired, ` +
          `${receiveReconcile.unresolved} unresolved.`,
      );
    }

    await enableCocoManager(coco);
    const openDatabase = database;

    findFinalizedReceiveSibling = async (
      operation: ReceiveOperation | null,
    ): Promise<string | null> => {
      if (!operation) return null;
      const fingerprint = receiveInputFingerprint(operation);
      const siblings = await repo.receiveOperationRepository.getByMintUrl(operation.mintUrl);
      return (
        siblings.find(
          (candidate) =>
            candidate.state === "finalized" &&
            receiveInputFingerprint(candidate) === fingerprint,
        )?.id ?? null
      );
    };

    const syncReceiveReservations = async (): Promise<void> => {
      for (const reservation of listProcessingReceiveTokens(openDatabase)) {
        if (!reservation.operationId) continue;
        try {
          const operation = await coco!.ops.receive.get(reservation.operationId);
          if (operation?.state === "finalized") {
            updateReceiveToken(openDatabase, reservation.tokenHash, {
              state: "succeeded",
              operationId: operation.id,
            });
          } else if (operation?.state === "rolled_back") {
            const finalizedSibling = await findFinalizedReceiveSibling(operation);
            updateReceiveToken(openDatabase, reservation.tokenHash, finalizedSibling
              ? {
                  state: "succeeded",
                  operationId: finalizedSibling,
                }
              : {
                  state: "failed",
                  operationId: operation.id,
                  error: operation.error || "Token receive was rolled back",
                });
          } else if (operation?.state === "prepared") {
            // A crash before execute had no mint side effect. Cancel the stale
            // prepared operation and permit a fresh exact-token attempt.
            await coco!.ops.receive.cancel(
              operation.id,
              "Cancelled interrupted receive before execution",
            );
            deleteReceiveTokenReservation(openDatabase, reservation.tokenHash);
          } else if (!operation) {
            deleteReceiveTokenReservation(openDatabase, reservation.tokenHash);
          }
        } catch (error) {
          // One damaged/stale reservation must never block daemon startup or
          // make every wallet write fail after recovery.
          logger.warn("Could not reconcile receive token reservation", {
            operationId: reservation.operationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    await syncReceiveReservations();

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

    // Recovery runs in the background so the daemon can serve wallet reads
    // immediately. Value-moving operations await the same promise below.
    runWalletRecovery(
      coco,
      (progress) => {
        recoveryPhase = progress.phase;
        recoveryFailedMintQuotes = progress.failedMintQuotes;
        if (progress.phase !== "done") {
          startupProgress(`Wallet recovery: ${progress.phase}...`);
        }
      },
      receiveRecoveryOperationIds,
    )
      .then(async () => {
        await syncReceiveReservations();
        recoveryDone = true;
        recoveryPhase = "done";
        recoveryResolve?.();
        startupProgress("Wallet recovery complete.");
      })
      .catch((error) => {
        recoveryDone = true;
        recoveryPhase = "error";
        recoveryError = error instanceof Error ? error.message : String(error);
        recoveryResolve?.();
        startupProgress(`Wallet recovery failed: ${recoveryError}`);
      });
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

  /**
   * Block a value-moving operation until background recovery has settled.
   * Reads stay ungated so the daemon can report balances/status immediately.
   */
  const waitForRecovery = async (): Promise<void> => {
    if (!recoveryDone) await recoveryPromise;
    if (recoveryError) {
      throw new Error(`Wallet is not ready: ${recoveryError}`);
    }
  };

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
      if (recoveryError) return "ERROR";
      if (!recoveryDone) return "RECOVERING";
      try {
        await coco.wallet.balances.total();
        return "UNLOCKED";
      } catch {
        return "ERROR";
      }
    },

    async getRecoveryProgress(): Promise<WalletRecoveryProgress> {
      return {
        state: recoveryError ? "ERROR" : recoveryDone ? "UNLOCKED" : "RECOVERING",
        phase: recoveryPhase,
        pendingSends: recoveryCounts.pendingSends,
        inflightProofs: recoveryCounts.inflightProofs,
        pendingMints: recoveryCounts.pendingMints,
        failedMintQuotes: recoveryFailedMintQuotes,
        ...(recoveryError ? { error: recoveryError } : {}),
      };
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
      const reservation = reserveReceiveToken(database, token);
      if (!reservation.acquired) {
        if (reservation.existing?.state === "succeeded") {
          return "Token already received successfully";
        }
        if (
          reservation.existing?.state === "processing" &&
          reservation.existing.operationId
        ) {
          // A prior request may have stopped after the mint call became
          // uncertain. Re-drive that one Coco operation instead of creating a
          // duplicate. Refresh is idempotent and uses its stored output data.
          try {
            const operation = await withTimeout(
              coco.ops.receive.refresh(reservation.existing.operationId),
              15_000,
            );
            if (operation.state === "finalized") {
              updateReceiveToken(database, reservation.tokenHash, {
                state: "succeeded",
                operationId: operation.id,
              });
              return "Token received successfully";
            }
            if (operation.state === "rolled_back") {
              const finalizedSibling = await findFinalizedReceiveSibling(operation);
              if (finalizedSibling) {
                updateReceiveToken(database, reservation.tokenHash, {
                  state: "succeeded",
                  operationId: finalizedSibling,
                });
                return "Token already received successfully";
              }
              updateReceiveToken(database, reservation.tokenHash, {
                state: "failed",
                operationId: operation.id,
                error: operation.error || "Token receive was rolled back",
              });
              throw new Error(operation.error || "Token receive was rolled back");
            }
          } catch (error) {
            const latest = await coco.ops.receive.get(reservation.existing.operationId);
            if (latest?.state === "finalized") {
              updateReceiveToken(database, reservation.tokenHash, {
                state: "succeeded",
                operationId: latest.id,
              });
              return "Token received successfully";
            }
            throw error;
          }
          throw new Error("Token receive is still unresolved");
        }
        if (reservation.existing?.state === "processing") {
          throw new Error("Token receive is already in progress");
        }
        throw new Error(reservation.existing?.error || "Token receive previously failed");
      }

      let preparedOperationId: string | undefined;
      try {
        await waitForRecovery();
        const prepared = await coco.ops.receive.prepare({ token });
        preparedOperationId = prepared.id;
        updateReceiveToken(database, reservation.tokenHash, {
          state: "processing",
          operationId: prepared.id,
        });
        await coco.ops.receive.execute(prepared.id);
        updateReceiveToken(database, reservation.tokenHash, {
          state: "succeeded",
          operationId: prepared.id,
        });
        return "Token received successfully";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (preparedOperationId) {
          let latest: Awaited<ReturnType<typeof coco.ops.receive.get>> = null;
          try {
            latest = await coco.ops.receive.get(preparedOperationId);
          } catch (lookupError) {
            logger.warn("Could not inspect failed receive operation", {
              operationId: preparedOperationId,
              error:
                lookupError instanceof Error ? lookupError.message : String(lookupError),
            });
          }
          if (latest?.state === "finalized") {
            updateReceiveToken(database, reservation.tokenHash, {
              state: "succeeded",
              operationId: preparedOperationId,
            });
            return "Token received successfully";
          }
          if (latest?.state === "executing") {
            updateReceiveToken(database, reservation.tokenHash, {
              state: "processing",
              operationId: preparedOperationId,
              error: message,
            });
          } else if (latest?.state === "rolled_back") {
            const finalizedSibling = await findFinalizedReceiveSibling(latest);
            if (finalizedSibling) {
              updateReceiveToken(database, reservation.tokenHash, {
                state: "succeeded",
                operationId: finalizedSibling,
              });
              return "Token already received successfully";
            }
            updateReceiveToken(database, reservation.tokenHash, {
              state: "failed",
              operationId: preparedOperationId,
              error: latest.error || message,
            });
          } else {
            // A prepared or missing operation had no known mint side effect.
            deleteReceiveTokenReservation(database, reservation.tokenHash);
          }
        } else {
          // Decode/validation failed before coco created an operation. Do not
          // permanently reserve malformed input or transient mint-fetch errors.
          releaseReceiveToken(database, reservation.tokenHash);
        }
        throw error;
      }
    },

    async receiveBolt11(amount: number, mintUrl?: string) {
      await waitForRecovery();
      const targetMint = mintUrl
        ? normalizeMintUrl(mintUrl)
        : walletConfig.defaultMintUrl;
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
      return { invoice: op.request as string, operationId: op.id };
    },

    async getMintQuote(operationId: string) {
      const op = await coco.ops.mint.get(operationId);
      if (!op || op.state === "init") return null;
      return {
        operationId: op.id,
        state: op.state,
        mintState: op.lastObservedRemoteState,
        amount: op.amount,
        mintUrl: op.mintUrl,
        error: op.error,
      };
    },

    async sendCashu(amount: number, mintUrl?: string): Promise<string> {
      await waitForRecovery();
      const targetMint = mintUrl
        ? normalizeMintUrl(mintUrl)
        : walletConfig.defaultMintUrl;
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
      await waitForRecovery();
      const targetMint = mintUrl
        ? normalizeMintUrl(mintUrl)
        : walletConfig.defaultMintUrl;
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
      await waitForRecovery();
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
      await waitForRecovery();
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
        // Let any in-flight recovery settle before closing the database from
        // underneath it. The recovery promise resolves on success or failure.
        await recoveryPromise;
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
      await waitForRecovery();
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
      await waitForRecovery();
      await npcApi().sync();
    },

    async cleanupStuckOperations(
      options: WalletCleanupOptions = {},
    ): Promise<WalletCleanupResult> {
      await waitForRecovery();
      const minAgeMs = options.minAgeMs ?? 7 * 24 * 60 * 60 * 1000;
      const dryRun = options.dryRun === true;
      const nowMs = Date.now();

      const [pendingMints, inFlightSends, preparedMelts] = await Promise.all([
        coco.ops.mint.listPending(),
        coco.ops.send.listInFlight(),
        coco.ops.melt.listPrepared(),
      ]);

      const filteredMints = options.mintUrl
        ? pendingMints.filter((op) => op.mintUrl === options.mintUrl)
        : pendingMints;
      const filteredSends = options.mintUrl
        ? inFlightSends.filter((op) => op.mintUrl === options.mintUrl)
        : inFlightSends;
      const filteredMelts = options.mintUrl
        ? preparedMelts.filter((op) => op.mintUrl === options.mintUrl)
        : preparedMelts;

      const selection = selectCleanupOperations({
        mints: filteredMints,
        sends: filteredSends,
        melts: filteredMelts,
        nowMs,
        minAgeMs,
      });

      const errors: WalletCleanupResult["errors"] = [];

      if (!dryRun) {
        const mintService = (
          coco as unknown as {
            mintOperationService: MintOperationServiceCleanup;
          }
        ).mintOperationService;

        for (const op of selection.mintsToFail) {
          try {
            await mintService.failPendingOperation(
              { id: op.id },
              {
                reason: "Expired unpaid mint quote cleaned up by routstrd",
                retryable: false,
                observedAt: nowMs,
              },
            );
          } catch (error) {
            errors.push({
              operationId: op.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        for (const op of selection.sendsToReclaim) {
          try {
            await coco.ops.send.reclaim(op.id);
          } catch (error) {
            errors.push({
              operationId: op.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        for (const op of selection.meltsToCancel) {
          try {
            await coco.ops.melt.cancel(op.id, "Cancelled by wallet cleanup");
          } catch (error) {
            errors.push({
              operationId: op.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      const actedOn =
        selection.mintsToFail.length +
        selection.sendsToReclaim.length +
        selection.meltsToCancel.length;
      const skipped =
        filteredMints.length + filteredSends.length + filteredMelts.length -
        actedOn;

      return {
        dryRun,
        failedMintQuotes: selection.mintsToFail.length,
        reclaimedSends: selection.sendsToReclaim.length,
        cancelledMelts: selection.meltsToCancel.length,
        skipped,
        errors,
      };
    },
  };
}
