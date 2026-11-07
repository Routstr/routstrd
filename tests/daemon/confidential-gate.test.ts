import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Runs in an isolated bun subprocess (config paths resolve at import time).
const SCENARIO = join(import.meta.dir, "confidential-gate.scenario.ts");

describe("x-routstr-verify: confidential", () => {
  test("is refused, never downgraded to plaintext, when it cannot run", () => {
    const dir = mkdtempSync(join(tmpdir(), "routstrd-confidential-gate-"));
    const res = spawnSync("bun", [SCENARIO], {
      env: { ...process.env, NODE_ENV: "test", ROUTSTRD_DIR: join(dir, "daemon") },
      stdout: "pipe",
      stderr: "pipe",
    });
    rmSync(dir, { recursive: true, force: true });
    const out = `${res.stdout}${res.stderr}`;
    expect(out).toContain("SCENARIO-OK");
    expect(res.status).toBe(0);
  });
});
