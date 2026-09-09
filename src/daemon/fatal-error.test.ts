import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "fs";
import { spawnCapture } from "../utils/spawn.ts";
import { tmpdir } from "os";
import { join } from "path";
import { exitOnUncaughtException } from "./fatal-error.ts";

const fatalErrorModule = JSON.stringify(join(import.meta.dirname, "fatal-error.ts"));

const fixturePaths: string[] = [];

afterEach(() => {
  while (fixturePaths.length > 0) {
    try {
      unlinkSync(fixturePaths.pop()!);
    } catch {
      // Best effort cleanup of temp fixtures.
    }
  }
});

/** Run a fixture script in a real subprocess so process.exit is for real. */
async function runFixture(source: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const scriptPath = join(
    tmpdir(),
    `routstrd-fatal-error-fixture-${crypto.randomUUID()}.ts`,
  );
  fixturePaths.push(scriptPath);
  writeFileSync(scriptPath, source);
  const proc = spawnCapture("bun", [scriptPath]);
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout,
    proc.stderr,
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("exitOnUncaughtException", () => {
  test("reports the error and exits with code 1", () => {
    let exitCode: number | undefined;
    const stderrLines: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      stderrLines.push(args.map(String).join(" "));
    };
    try {
      exitOnUncaughtException(new Error("boom"), (code) => {
        exitCode = code;
      });
    } finally {
      console.error = originalConsoleError;
    }
    expect(exitCode).toBe(1);
    expect(stderrLines.join("\n")).toContain("boom");
  });

  test("handles non-Error thrown values", () => {
    let exitCode: number | undefined;
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      exitOnUncaughtException("string failure", (code) => {
        exitCode = code;
      });
    } finally {
      console.error = originalConsoleError;
    }
    expect(exitCode).toBe(1);
  });
});

describe("installGlobalErrorHandlers (subprocess)", () => {
  test("an uncaught exception exits the process with code 1", async () => {
    const { exitCode, stderr } = await runFixture(`
      import { installGlobalErrorHandlers } from ${fatalErrorModule};
      installGlobalErrorHandlers();
      setTimeout(() => {
        throw new Error("boom-uncaught");
      }, 10);
    `);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("boom-uncaught");
  });

  test("an unhandled rejection is logged without exiting", async () => {
    const { exitCode, stdout } = await runFixture(`
      import { installGlobalErrorHandlers } from ${fatalErrorModule};
      installGlobalErrorHandlers();
      Promise.reject(new Error("boom-rejection"));
      setTimeout(() => {
        console.log("STILL-ALIVE");
      }, 50);
    `);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("STILL-ALIVE");
  });
});
