import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// The scenario mutates process.env.ROUTSTRD_DIR before the config module is
// loaded, so it runs in an isolated bun subprocess (same approach as
// config-store.perms.test.ts).

const SCENARIO = join(import.meta.dir, "auto-refresh.scenario.ts");

function runScenario(name: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), `routstrd-auto-refresh-${name}-`));
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
  return { code: res.status ?? res.exitCode ?? -1, out };
}

describe("auto-refresh settings endpoint", () => {
  test("persists the scheduled-refresh toggle to the daemon config", () => {
    const { code, out } = runScenario("toggle-endpoint");
    expect(out).toContain("SCENARIO-OK");
    expect(code).toBe(0);
  });
});
