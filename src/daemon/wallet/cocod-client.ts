import { existsSync } from "fs";
import { createHash } from "crypto";
import { isAbsolute } from "path";
import { logger } from "../../utils/logger";
import { withCrossProcessLock } from "../../utils/process-lock";
import type { HistoryEntry } from "@cashu/coco-core";

const DEFAULT_CONFIG_DIR =
  process.env.COCOD_DIR || `${process.env.HOME || process.env.USERPROFILE || ""}/.cocod`;
const DEFAULT_SOCKET_PATH =
  process.env.COCOD_SOCKET || `${DEFAULT_CONFIG_DIR}/cocod.sock`;

type UnixRequestInit = RequestInit & { unix: string };

type CommandResponse<T> = {
  output?: T;
  error?: string;
};

type CocodFetch = (
  input: string | URL | Request,
  init?: UnixRequestInit,
) => Promise<Response>;

type SpawnedProcess = {
  exited: Promise<number>;
  unref?: () => void;
};

type SpawnDaemon = (
  args: string[],
  env: Record<string, string>,
) => SpawnedProcess;

export type CocodState = "UNINITIALIZED" | "LOCKED" | "UNLOCKED" | "ERROR";

export type CocodBalanceOutput = Record<string, { sats?: number } | number>;

/** NPC (npubx.cash) Lightning address details for this wallet. */
export interface NpcAddress {
  /** Full Lightning address, e.g. "alice@npubx.cash" (npub fallback when no username is set). */
  address: string;
  /** NPC username, when one has been claimed. */
  name?: string;
  /** Nostr hex pubkey of the NPC account (only available from the in-process wallet). */
  pubkey?: string;
}

/** Result of an NPC username claim attempt. */
export interface NpcUsernameResult {
  success: boolean;
  /** Present when NPC requires payment to claim the username. */
  paymentRequest?: {
    amount?: number;
    mints?: string[];
    [key: string]: unknown;
  };
}

export class CocodHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CocodHttpError";
    this.status = status;
  }
}

export interface CocodClient {
  ping(): Promise<boolean>;
  getStatus(): Promise<CocodState>;
  unlock(passphrase: string): Promise<string>;
  getBalances(): Promise<Record<string, number>>;
  receiveCashu(token: string): Promise<string>;
  receiveBolt11(amount: number, mintUrl?: string): Promise<string>;
  sendCashu(amount: number, mintUrl?: string): Promise<string>;
  sendBolt11(invoice: string, mintUrl?: string): Promise<string>;
  listMints(): Promise<string[]>;
  addMint(url: string): Promise<string>;
  getMintInfo(url: string): Promise<unknown>;
  getDefaultMint(): Promise<string | null>;
  setDefaultMint(url: string): Promise<string>;
  /** Release resources held by in-process wallet implementations. */
  dispose?(): Promise<void>;
  getHistory(offset?: number, limit?: number): Promise<HistoryEntry[]>;
  /** NPC (npubx.cash) Lightning address for this wallet. */
  getNpcAddress(): Promise<NpcAddress>;
  /** Claim an NPC username; pass confirm=true to pay the claim fee from the wallet. */
  setNpcUsername(username: string, confirm?: boolean): Promise<NpcUsernameResult>;
  /** Manually trigger an NPC quote sync into the wallet. */
  syncNpc(): Promise<void>;
}

export function resolveCocodExecutable(cocodPath?: string | null): string {
  const trimmed = cocodPath?.trim();
  return trimmed || "cocod";
}

export async function isCocodInstalled(
  cocodPath?: string | null,
): Promise<boolean> {
  const executable = resolveCocodExecutable(cocodPath);

  if (
    isAbsolute(executable) ||
    executable.includes("/") ||
    executable.includes("\\")
  ) {
    return existsSync(executable);
  }

  try {
    const command = process.platform === "win32" ? "where.exe" : "which";
    const proc = Bun.spawn({
      cmd: [command, executable],
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export function normalizeBalances(
  output: CocodBalanceOutput | undefined,
): Record<string, number> {
  if (!output) return {};

  return Object.fromEntries(
    Object.entries(output).map(([mintUrl, value]) => {
      if (typeof value === "number") {
        return [mintUrl, value];
      }
      return [mintUrl, Number(value?.sats ?? 0)];
    }),
  );
}

function parseMintList(output: string | undefined): string[] {
  return (output || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

export function createCocodClient(
  options: {
    cocodPath?: string | null;
    socketPath?: string;
    fetchImpl?: CocodFetch;
    spawnDaemon?: SpawnDaemon;
    pollIntervalMs?: number;
    startupTimeoutMs?: number;
  } = {},
): CocodClient {
  const executable = resolveCocodExecutable(options.cocodPath);
  const socketPath = options.socketPath || DEFAULT_SOCKET_PATH;
  const startupLockPath = `${socketPath}.startup.lock`;
  const fetchImpl = options.fetchImpl || (fetch as CocodFetch);
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const startupTimeoutMs = options.startupTimeoutMs ?? 5000;

  const spawnDaemon: SpawnDaemon =
    options.spawnDaemon ||
    ((args, env) => {
      const proc = Bun.spawn(args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        env,
      });
      proc.unref();
      return proc;
    });

  let startPromise: Promise<void> | null = null;

  async function fetchJson<T>(
    path: string,
    init: Omit<UnixRequestInit, "unix"> = {},
  ): Promise<CommandResponse<T>> {
    const method = init.method || "GET";
    const requestInit: UnixRequestInit = {
      ...init,
      unix: socketPath,
    };

    const response = await fetchImpl(`http://localhost${path}`, requestInit);
    const rawText = await response.text();
    // logger.debug(
    //   `[fetchJson] ${method} ${path} status=${response.status} body=${rawText}`,
    // );

    if (!rawText.trim()) {
      throw new CocodHttpError(
        response.ok ? 502 : response.status,
        `Empty response from cocod for ${method} ${path}`,
      );
    }

    let data: CommandResponse<T>;
    try {
      data = JSON.parse(rawText) as CommandResponse<T>;
    } catch {
      throw new CocodHttpError(
        response.ok ? 502 : response.status,
        `Invalid JSON response from cocod for ${method} ${path}`,
      );
    }

    if (!data || typeof data !== "object") {
      throw new CocodHttpError(
        response.ok ? 502 : response.status,
        `Unexpected response shape from cocod for ${method} ${path}`,
      );
    }

    const errorMessage = toErrorText((data as CommandResponse<T>).error);
    if (errorMessage) {
      throw new CocodHttpError(
        response.ok ? 400 : response.status,
        errorMessage,
      );
    }

    if (!response.ok) {
      throw new CocodHttpError(
        response.status,
        data.error || response.statusText || `HTTP ${response.status}`,
      );
    }

    return data;
  }

  async function pingInternal(): Promise<boolean> {
    try {
      await fetchJson<string>("/ping");
      return true;
    } catch {
      return false;
    }
  }

  async function startDaemon(): Promise<void> {
    const env = { ...process.env, COCOD_SOCKET: socketPath };
    const proc = spawnDaemon([executable, "init"], env);
    const maxPolls = Math.ceil(startupTimeoutMs / pollIntervalMs);
    let exitCode: number | null = null;

    void proc.exited.then((code) => {
      exitCode = code;
    });

    for (let i = 0; i < maxPolls; i++) {
      await delay(pollIntervalMs);

      if (exitCode !== null && exitCode !== 0) {
        throw new Error(`cocod init exited early with code ${exitCode}`);
      }

      if (await pingInternal()) {
        logger.debug(`Connected to cocod daemon on ${socketPath}`);
        return;
      }
    }

    throw new Error(
      `cocod failed to start within ${Math.round(startupTimeoutMs / 1000)} seconds`,
    );
  }

  async function ensureDaemonRunning(): Promise<void> {
    if (await pingInternal()) {
      return;
    }

    if (!startPromise) {
      startPromise = withCrossProcessLock(
        startupLockPath,
        async () => {
          if (await pingInternal()) {
            return;
          }

          logger.debug(`Starting cocod daemon via ${executable} init...`);
          await startDaemon();
        },
        {
          acquireTimeoutMs: startupTimeoutMs + 30_000,
          staleAfterMs: startupTimeoutMs + 30_000,
          log: (message) => logger.debug(message),
        },
      ).finally(() => {
        startPromise = null;
      });
    }

    await startPromise;
  }

  async function callDaemon<T>(
    path: string,
    init: Omit<UnixRequestInit, "unix"> = {},
  ): Promise<T> {
    await ensureDaemonRunning();
    const response = await fetchJson<T>(path, init);
    return response.output as T;
  }

  function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return callDaemon<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  return {
    async ping(): Promise<boolean> {
      return pingInternal();
    },
    async getStatus(): Promise<CocodState> {
      return callDaemon<CocodState>("/status");
    },
    async unlock(passphrase: string): Promise<string> {
      return post<string>("/unlock", { passphrase });
    },
    async getBalances(): Promise<Record<string, number>> {
      const output = await callDaemon<CocodBalanceOutput>("/balance");
      return normalizeBalances(output);
    },
    async receiveCashu(token: string): Promise<string> {
      logger.debug(
        `[receiveCashu] Receiving Cashu token ${tokenFingerprint(token)}`,
      );
      const message = await callDaemon<string>("/receive/cashu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (typeof message !== "string" || !message.trim()) {
        throw new CocodHttpError(
          502,
          "Unexpected response from cocod while receiving Cashu token.",
        );
      }
      logger.debug(`[receiveCashu] Full response.output:`, message);
      return message;
    },
    async receiveBolt11(amount: number, mintUrl?: string): Promise<string> {
      return post<string>("/receive/bolt11", { amount, mintUrl });
    },
    async sendCashu(amount: number, mintUrl?: string): Promise<string> {
      return post<string>("/send/cashu", { amount, mintUrl });
    },
    async sendBolt11(invoice: string, mintUrl?: string): Promise<string> {
      return post<string>("/send/bolt11", { invoice, mintUrl });
    },
    async listMints(): Promise<string[]> {
      const output = await callDaemon<string>("/mints/list");
      return parseMintList(output);
    },
    async addMint(url: string): Promise<string> {
      return post<string>("/mints/add", { url });
    },
    async getMintInfo(url: string): Promise<unknown> {
      return post<unknown>("/mints/info", { url });
    },
    async getDefaultMint(): Promise<string | null> {
      return callDaemon<string | null>("/mints/default");
    },
    async setDefaultMint(url: string): Promise<string> {
      return post<string>("/mints/default", { url });
    },
    async getHistory(_offset?: number, _limit?: number): Promise<HistoryEntry[]> {
      return [];
    },
    async getNpcAddress(): Promise<NpcAddress> {
      const address = await callDaemon<string>("/npc/address");
      if (typeof address !== "string" || !address.trim()) {
        throw new CocodHttpError(
          502,
          "Unexpected response from cocod while fetching NPC address.",
        );
      }
      const trimmed = address.trim();
      const localPart = trimmed.split("@")[0];
      return {
        address: trimmed,
        ...(localPart && !localPart.startsWith("npub1")
          ? { name: localPart }
          : {}),
      };
    },
    async setNpcUsername(
      username: string,
      confirm?: boolean,
    ): Promise<NpcUsernameResult> {
      // cocod answers 402 with a payment-required message when the claim fee
      // has not been confirmed; fetchJson preserves that status on the thrown
      // CocodHttpError, so callers can surface it unchanged.
      const result = await post<{ success?: boolean }>("/npc/username", {
        username,
        confirm: confirm === true,
      });
      return { success: result?.success !== false };
    },
    async syncNpc(): Promise<void> {
      throw new CocodHttpError(
        501,
        "Manual NPC sync is not supported by the legacy cocod client.",
      );
    },
  };
}
