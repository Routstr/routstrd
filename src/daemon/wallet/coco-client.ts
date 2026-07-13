import { initializeCoco, getEncodedToken } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { mnemonicToSeedSync } from "@scure/bip39";
import type { CocodClient, CocodState } from "./cocod-client";
import { logger } from "../../utils/logger";

const CONFIG_DIR =
  process.env.COCOD_DIR ||
  `${process.env.HOME || process.env.USERPROFILE || ""}/.cocod`;

const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DB_PATH = join(CONFIG_DIR, "coco.db");
const LEGACY_COCOD_SOCKET =
  process.env.COCOD_SOCKET || join(CONFIG_DIR, "cocod.sock");
const LEGACY_COCOD_PID_FILE = join(CONFIG_DIR, "cocod.pid");

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
  fetchImpl?: LegacyCocodFetch;
  timeoutMs?: number;
}

interface CocodConfig {
  mnemonic: string;
  encrypted: boolean;
}

function loadMnemonic(): string {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(
      `Config file not found at ${CONFIG_FILE}. Run 'routstrd onboard' first.`,
    );
  }
  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as CocodConfig;
  if (config.encrypted) {
    throw new Error(
      "Encrypted wallets are not supported yet. Please use an unencrypted wallet.",
    );
  }
  return config.mnemonic;
}

async function seedGetter(): Promise<Uint8Array> {
  const mnemonic = loadMnemonic();
  return mnemonicToSeedSync(mnemonic);
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
  const socketPath = options.socketPath || LEGACY_COCOD_SOCKET;
  const pidFilePath = options.pidFilePath || LEGACY_COCOD_PID_FILE;
  const pathExists = options.pathExists || existsSync;
  const readFile = options.readFile || ((path) => readFileSync(path, "utf-8"));
  const isProcessRunning = options.isProcessRunning || defaultIsProcessRunning;

  const getRunningLegacyPid = (): number | null => {
    if (!pathExists(pidFilePath)) return null;

    try {
      const pid = Number.parseInt(readFile(pidFilePath).trim(), 10);
      return Number.isInteger(pid) && pid > 0 && isProcessRunning(pid)
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
        "Run 'cocod stop' and try again.",
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
          "Run 'cocod stop' and try again.",
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

export async function createCocoClient(): Promise<CocodClient> {
  await assertLegacyCocodNotRunning();

  const database = new Database(DB_PATH);
  const repo = new SqliteRepositories({ database });
  await repo.init();

  const coco = await initializeCoco({
    repo,
    seedGetter,
  });

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
      // Wallet access is controlled via the mnemonic in ~/.cocod/config.json.
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
      const mints = await coco.mint.getAllTrustedMints();
      const targetMint = mintUrl || mints[0]?.mintUrl;
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
      const mints = await coco.mint.getAllTrustedMints();
      const targetMint = mintUrl || mints[0]?.mintUrl;
      if (!targetMint) {
        throw new Error("No trusted mint available for sending");
      }
      const prepared = await coco.ops.send.prepare({
        mintUrl: targetMint,
        amount,
      });
      try {
        const { token } = await coco.ops.send.execute(prepared.id);
        return getEncodedToken(token);
      } catch (error) {
        await coco.ops.send.cancel(prepared.id);
        throw error;
      }
    },

    async sendBolt11(invoice: string, mintUrl?: string): Promise<string> {
      const mints = await coco.mint.getAllTrustedMints();
      const targetMint = mintUrl || mints[0]?.mintUrl;
      if (!targetMint) {
        throw new Error("No trusted mint available for Lightning payment");
      }
      const prepared = await coco.ops.melt.prepare({
        mintUrl: targetMint,
        method: "bolt11",
        methodData: { invoice },
      });
      try {
        await coco.ops.melt.execute(prepared.id);
        return "Payment sent successfully";
      } catch (error) {
        await coco.ops.melt.cancel(prepared.id);
        throw error;
      }
    },

    async listMints(): Promise<string[]> {
      const mints = await coco.mint.getAllTrustedMints();
      return mints.map((m) => m.mintUrl);
    },

    async addMint(url: string): Promise<string> {
      await coco.mint.addMint(url, { trusted: true });
      return `Mint ${url} added successfully`;
    },

    async getMintInfo(url: string): Promise<unknown> {
      return coco.mint.getMintInfo(url);
    },
  };
}
