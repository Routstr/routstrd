import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case loads config in an isolated process, without touching user config
// or sharing fetch mocks with other test files.
async function runCase(config: object, action: string, responses: number[]) {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-retry-"));
  try {
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    const script = `
      const { callDaemon, callAuth, isDaemonRunning } = await import(${JSON.stringify(join(import.meta.dir, "daemon-client.ts"))});
      const responses = ${JSON.stringify(responses)};
      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), method: init?.method ?? "GET" });
        const status = responses.shift();
        if (status === 0) throw new TypeError("Connection reset");
        if (status === undefined) throw new Error("Unexpected request");
        return Response.json(status >= 400 ? {error: "denied"} : {output: "ok"}, {status});
      };
      let result, error;
      try { result = await (${action}); } catch (e) { error = e.message; }
      console.log(JSON.stringify({ requests, result, error }));
    `;
    const proc = Bun.spawn([process.execPath, "--eval", script], {
      env: { ...process.env, ROUTSTRD_DIR: dir }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
    return JSON.parse(output) as {
      requests: { url: string; method: string }[];
      result?: unknown;
      error?: string;
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const remote = { daemonUrl: "http://localhost:18008" };

describe("daemon loopback retries", () => {
  test("GET retries a connection failure", async () => {
    const r = await runCase(remote, 'callDaemon("/status")', [0, 200]);
    expect(r.result).toEqual({ output: "ok" });
    expect(r.requests.map(r => r.url)).toEqual([
      "http://localhost:18008/status", "http://127.0.0.1:18008/status",
    ]);
  });

  for (const method of ["POST", "PATCH", "DELETE"]) {
    for (const [name, config, client] of [
      ["remote", remote, "callDaemon"],
      ["local", { host: "0.0.0.0", port: 18008 }, "callDaemon"],
      ["auth", { authUrl: "http://localhost:18008" }, "callAuth"],
    ] as const) {
      test(`${name} ${method} is never replayed after a reset`, async () => {
        const r = await runCase(config, `${client}("/wallet/send/cashu", {method: "${method}", body: {amount: 10}})`, [200, 0, 200]);
        expect(r.error).toContain("outcome is unknown");
        expect(r.requests.map(r => r.method)).toEqual(["GET", method]);
      });
    }
  }

  test("selects IPv4 with health probes before sending POST once", async () => {
    const r = await runCase(remote, 'callDaemon("/wallet/send/cashu", {method: "POST"})', [0, 200, 200]);
    expect(r.result).toEqual({ output: "ok" });
    expect(r.requests).toEqual([
      { url: "http://localhost:18008/health", method: "GET" },
      { url: "http://127.0.0.1:18008/health", method: "GET" },
      { url: "http://127.0.0.1:18008/wallet/send/cashu", method: "POST" },
    ]);
  });

  test("a single-address write also reports an unknown outcome", async () => {
    const r = await runCase({daemonUrl: "http://127.0.0.1:18008"}, 'callDaemon("/wallet/send/cashu", {method: "POST"})', [0]);
    expect(r.error).toContain("outcome is unknown");
    expect(r.requests).toHaveLength(1);
  });

  test("write address selection stops on HTTP errors", async () => {
    const r = await runCase(remote, 'callDaemon("/wallet/send/cashu", {method: "POST"})', [403, 200]);
    expect(r.error).toBe("denied");
    expect(r.requests).toHaveLength(1);
  });

  for (const config of [remote, {host: "0.0.0.0", port: 18008}]) {
    test(`health HTTP errors stop fallback (${JSON.stringify(config)})`, async () => {
      const r = await runCase(config, "isDaemonRunning()", [403, 200]);
      expect(r.result).toBe(false);
      expect(r.requests).toHaveLength(1);
    });
  }

  test("health connection failures still allow fallback", async () => {
    const r = await runCase(remote, "isDaemonRunning()", [0, 200]);
    expect(r.result).toBe(true);
    expect(r.requests).toHaveLength(2);
  });
});
