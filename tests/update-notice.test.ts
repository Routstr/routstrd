import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { VERSION } from "../src/version";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function pingWithCache(updateCheck?: boolean, current = VERSION, checkedAt = new Date().toISOString()) {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-update-notice-"));
  dirs.push(dir);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req) => Response.json(new URL(req.url).pathname === "/health" ? { ok: true } : { output: "pong" }),
  });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ port: server.port, host: "127.0.0.1", updateCheck }));
  writeFileSync(join(dir, "update-state.json"), JSON.stringify({ current, latest: "0.5.0", hasUpdate: true, checkedAt }));
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/index.ts"), "ping"], {
      env: { ...process.env, ROUTSTRD_DIR: dir, ROUTSTRD_NO_UPDATE_CHECK: "1" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("pong");
    return stderr;
  } finally { server.stop(true); }
}

describe("CLI cached update notice", () => {
  test("enabled by default and no longer controlled by the removed environment variable", async () => {
    expect(await pingWithCache()).toContain("A new routstrd version is available");
  });
  test("config false suppresses notices", async () => {
    expect(await pingWithCache(false)).not.toContain("A new routstrd version is available");
  });
  test("mismatched or expired cache does not advertise an update", async () => {
    expect(await pingWithCache(true, "0.1.0")).not.toContain("A new routstrd version is available");
    expect(await pingWithCache(true, VERSION, "2020-01-01T00:00:00.000Z")).not.toContain("A new routstrd version is available");
  });
});
