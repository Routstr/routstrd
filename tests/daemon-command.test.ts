import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tempDirs: string[] = [];

function freshConfigPath(): string {
  const path = mkdtempSync(join(tmpdir(), "routstrd-daemon-command-test-"));
  rmSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("daemon command", () => {
  test("reports startup failures on stderr and exits nonzero", async () => {
    const entrypoint = join(import.meta.dir, "../src/index.ts");
    const proc = Bun.spawn([process.execPath, entrypoint, "daemon", "--port", "9999"], {
      env: { ...process.env, ROUTSTRD_DIR: freshConfigPath() },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("routstrd command failed:");
  });
});
