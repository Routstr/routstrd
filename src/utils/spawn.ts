/**
 * Small `node:child_process` helper used in place of `Bun.spawn`, so the same
 * code runs on Bun and Deno.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";

export interface SpawnCaptureHandle {
  /** Resolves with the exit code (or 1 if the process could not be spawned). */
  exited: Promise<number>;
  kill(): void;
  /** Captured stdout, decoded as UTF-8. Empty when stdout was not piped. */
  stdout: Promise<string>;
  /** Captured stderr, decoded as UTF-8. Empty when stderr was not piped. */
  stderr: Promise<string>;
}

/** Spawns a process and captures its output streams. */
export function spawnCapture(
  command: string,
  args: string[] = [],
  options: { stdout?: "pipe" | "ignore"; stderr?: "pipe" | "ignore"; env?: NodeJS.ProcessEnv } = {},
): SpawnCaptureHandle {
  const spawnOptions: SpawnOptions = {
    stdio: ["ignore", options.stdout ?? "pipe", options.stderr ?? "pipe"],
    ...(options.env ? { env: options.env } : {}),
  };
  const child = spawn(command, args, spawnOptions);

  const collect = (stream: NodeJS.ReadableStream | null): Promise<string> =>
    stream
      ? new Promise<string>((resolve) => {
        let text = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => { text += chunk; });
        stream.on("error", () => resolve(text));
        stream.on("end", () => resolve(text));
      })
      : Promise.resolve("");

  return {
    exited: new Promise<number>((resolve) => {
      // "error" fires instead of "exit" when the binary is missing.
      child.on("error", () => resolve(1));
      child.on("exit", (code) => resolve(code ?? 0));
    }),
    kill: () => child.kill(),
    stdout: collect(child.stdout),
    stderr: collect(child.stderr),
  };
}

/**
 * Reads a byte range out of a file, as UTF-8.
 *
 * Replaces `Bun.file(path).slice(start, end).text()`, which has no Deno
 * equivalent. Used for tailing the daemon debug log.
 */
export function readFileRange(path: string, start: number, end: number): string {
  const length = end - start;
  if (length <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
