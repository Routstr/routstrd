import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// These scenarios mutate process.env.ROUTSTRD_DIR before the config-store
// module is loaded, and other test files import the same module singleton
// first — so each scenario runs in an isolated bun subprocess where the env
// is guaranteed to be in place before module evaluation.

const SCENARIO = join(import.meta.dir, "config-store.scenario.ts");

function runScenario(name: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), `routstrd-cfg-${name}-`));
  const res = spawnSync("bun", [SCENARIO, name], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      ROUTSTRD_DIR: join(dir, "daemon"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${res.stdout}${res.stderr}`;
  rmSync(dir, { recursive: true, force: true });
  // bun's spawnSync reports the exit code in `status` (exitCode is undefined).
  return { code: res.status ?? res.exitCode ?? -1, out };
}

describe("daemon config store permissions", () => {
  test("fresh install: config dir 0700, config file 0600, atomic write", () => {
    const { code, out } = runScenario("fresh-install");
    expect(out).toContain("SCENARIO-OK");
    expect(code).toBe(0);
  });

  test("existing over-permissive install (0755/0644) is repaired", () => {
    const { code, out } = runScenario("repair-perms");
    expect(out).toContain("SCENARIO-OK");
    expect(code).toBe(0);
  });

  test("write failure surfaces synchronously with no temp file left", () => {
    const { code, out } = runScenario("write-failure");
    expect(out).toContain("SCENARIO-OK");
    expect(code).toBe(0);
  });

  test("corrupt JSON falls back to defaults", () => {
    const { code, out } = runScenario("corrupt-json");
    expect(out).toContain("SCENARIO-OK");
    expect(code).toBe(0);
  });
});
