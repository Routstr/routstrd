import { randomUUID } from "crypto";
import { mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { dirname } from "path";

export interface CrossProcessLockOptions {
  /** How long to wait while another process holds the lock. */
  acquireTimeoutMs?: number;
  /** How often to retry acquiring the lock. */
  retryIntervalMs?: number;
  /** Treat locks older than this as stale even if their PID cannot be checked. */
  staleAfterMs?: number;
  /** Optional logger used when removing stale locks. */
  log?: (message: string) => void;
}

interface LockOwner {
  pid: number;
  createdAt: number;
  token?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function readLockOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const raw = await readFile(`${lockDir}/owner.json`, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.createdAt === "number"
    ) {
      return {
        pid: parsed.pid,
        createdAt: parsed.createdAt,
        token: typeof parsed.token === "string" ? parsed.token : undefined,
      };
    }
  } catch {
    // The lock may have been created but not fully written yet.
  }
  return null;
}

async function isLockStale(
  lockDir: string,
  staleAfterMs: number,
): Promise<boolean> {
  const owner = await readLockOwner(lockDir);
  if (owner) {
    return !isProcessRunning(owner.pid) || Date.now() - owner.createdAt > staleAfterMs;
  }

  try {
    const info = await stat(lockDir);
    return Date.now() - info.mtimeMs > staleAfterMs;
  } catch {
    return false;
  }
}

export async function acquireCrossProcessLock(
  lockDir: string,
  options: CrossProcessLockOptions = {},
): Promise<() => Promise<void>> {
  const acquireTimeoutMs = options.acquireTimeoutMs ?? 120_000;
  const retryIntervalMs = options.retryIntervalMs ?? 100;
  const staleAfterMs = options.staleAfterMs ?? 120_000;
  const deadline = Date.now() + acquireTimeoutMs;

  await mkdir(dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir);
      const token = randomUUID();
      const owner: LockOwner = { pid: process.pid, createdAt: Date.now(), token };
      await writeFile(`${lockDir}/owner.json`, JSON.stringify(owner), "utf8");
      let released = false;
      return async () => {
        if (released) return;
        released = true;

        const currentOwner = await readLockOwner(lockDir);
        if (currentOwner?.token === token) {
          await rm(lockDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }

      if (await isLockStale(lockDir, staleAfterMs)) {
        options.log?.(`Removing stale lock at ${lockDir}`);
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to acquire lock ${lockDir}`);
      }

      await delay(retryIntervalMs);
    }
  }
}

export async function withCrossProcessLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  options: CrossProcessLockOptions = {},
): Promise<T> {
  const release = await acquireCrossProcessLock(lockDir, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
