import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// The scenario mutates process.env.ROUTSTRD_DIR before the config module is
// loaded, so it runs in an isolated bun subprocess (same approach as
// auto-refresh.test.ts).

const SCENARIO = join(import.meta.dir, "auto-model-path.scenario.ts");

function runScenario(name: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), `routstrd-auto-model-path-${name}-`));
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

describe("auto model path settings endpoint", () => {
  test("persists the toggle and reports a pending restart", () => {
    const { code, out } = runScenario("enable-from-off");
    expect(out).toContain("SCENARIO-OK");
    expect(code).toBe(0);
  });

  test("re-posting the active value does not request a restart", () => {
    const { code, out } = runScenario("disable-from-on");
    expect(out).toContain("SCENARIO-OK");
    expect(code).toBe(0);
  });
});
