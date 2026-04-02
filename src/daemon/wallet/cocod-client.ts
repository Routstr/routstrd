import { existsSync } from "fs";
import { logger } from "../../utils/logger";

const DEFAULT_CONFIG_DIR = `${process.env.HOME || process.env.USERPROFILE || ""}/.cocod`;
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
}

export function resolveCocodExecutable(cocodPath?: string | null): string {
  const trimmed = cocodPath?.trim();
  return trimmed || "cocod";
}

export async function isCocodInstalled(
  cocodPath?: string | null,
): Promise<boolean> {
  const executable = resolveCocodExecutable(cocodPath);

  if (executable.includes("/")) {
    return existsSync(executable);
  }

  try {
    const proc = Bun.spawn({
      cmd: ["which", executable],
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
    const requestInit: UnixRequestInit = {
      ...init,
      unix: socketPath,
    };

    const response = await fetchImpl(`http://localhost${path}`, requestInit);
    const rawText = await response.text();
    // logger.log(`[fetchJson] ${init.method || "GET"} ${path} status=${response.status} body=${rawText}`);
    const data = JSON.parse(rawText) as CommandResponse<T>;
    const errorMessage =
      typeof data.error === "string" ? data.error.trim() : "";
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
    const proc = spawnDaemon([executable, "daemon"], env);
    const maxPolls = Math.ceil(startupTimeoutMs / pollIntervalMs);
    let exitCode: number | null = null;

    void proc.exited.then((code) => {
      exitCode = code;
    });

    for (let i = 0; i < maxPolls; i++) {
      await delay(pollIntervalMs);

      if (exitCode !== null) {
        throw new Error(`cocod daemon exited early with code ${exitCode}`);
      }

      if (await pingInternal()) {
        logger.log(`Connected to cocod daemon on ${socketPath}`);
        return;
      }
    }

    throw new Error(
      `cocod daemon failed to start within ${Math.round(startupTimeoutMs / 1000)} seconds`,
    );
  }

  async function ensureDaemonRunning(): Promise<void> {
    if (await pingInternal()) {
      return;
    }

    if (!startPromise) {
      logger.log(`Starting cocod daemon via ${executable}...`);
      startPromise = startDaemon().finally(() => {
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
    const res = callDaemon<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    logger.log("DEBUG", res);
    return res;
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
      logger.log(`[receiveCashu] Receiving Cashu token...`);
      logger.log(`[receiveCashu] Token:`, token);
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
      logger.log(`[receiveCashu] Full response.output:`, message);
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
  };
}
