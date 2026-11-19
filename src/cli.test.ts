import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateSecretKey, nip19 } from "nostr-tools";
import { npubFromSecretKey } from "./utils/nip98";
import {
  collectRecentRequestsFromLines,
  formatAutoModelPathStatus,
  getLivePidFileOwner,
  initializeWallet,
  parseAutoModelPathArg,
  parseMonthlyLimitSats,
  parseStructuredLogLine,
} from "./cli";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-wallet-test-"));
  tempDirs.push(dir);
  return dir;
}

function permissions(path: string): number {
  return statSync(path).mode & 0o777;
}

type ProxyRequest = { method: string; path: string; body?: unknown };

/** A 64-char hex pubkey; the CLI normalizes it to an npub1... value. */
const TEST_NPUB = "ab".repeat(32);

/**
 * Run a `routstrd` subcommand against a fake auth proxy. `/health` answers
 * unconditionally because the CLI probes it before every management command;
 * every other request is recorded and answered by `respond`.
 */
async function runAgainstProxy(
  args: string[],
  respond: (request: ProxyRequest) => Response,
) {
  const requests: ProxyRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ status: "ok" });
      const raw = await req.text();
      const request = { method: req.method, path, body: raw ? JSON.parse(raw) : undefined };
      requests.push(request);
      return respond(request);
    },
  });
  const dir = makeTempDir();
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ daemonUrl: server.url.origin, updateCheck: false }),
  );
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
      env: { ...process.env, ROUTSTRD_DIR: dir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, requests };
  } finally {
    server.stop(true);
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getLivePidFileOwner", () => {
  test("returns a live owner from a valid PID file", () => {
    expect(
      getLivePidFileOwner("/wallet/wallet.pid", {
        readFile: () => "4242\n",
        isProcessRunning: (pid) => pid === 4242,
      }),
    ).toBe(4242);
  });

  test("rejects missing, malformed, dead, and non-positive owners", () => {
    const running = () => true;
    expect(
      getLivePidFileOwner("/missing", {
        readFile: () => {
          throw new Error("ENOENT");
        },
        isProcessRunning: running,
      }),
    ).toBeNull();
    expect(
      getLivePidFileOwner("/malformed", {
        readFile: () => "not-a-pid",
        isProcessRunning: running,
      }),
    ).toBeNull();
    expect(
      getLivePidFileOwner("/zero", {
        readFile: () => "0",
        isProcessRunning: running,
      }),
    ).toBeNull();
    expect(
      getLivePidFileOwner("/dead", {
        readFile: () => "4242",
        isProcessRunning: () => false,
      }),
    ).toBeNull();
  });
});

describe("parseStructuredLogLine", () => {
  test("extracts timestamp, level, request id, model, and routing flag", () => {
    const line =
      "[2026-08-27T13:00:00.000Z] [INFO] [req:a1b2c3d4] [model:gpt-5] Routing request with path: /v1/chat/completions";

    expect(parseStructuredLogLine(line)).toEqual({
      timestamp: "2026-08-27T13:00:00.000Z",
      level: "INFO",
      requestId: "a1b2c3d4",
      modelId: "gpt-5",
      isRouting: true,
    });
  });

  test("parses SDK child lines without marking them as routing lines", () => {
    const line =
      "[2026-08-27T13:00:01.000Z] [DEBUG] [req:a1b2c3d4] [model:gpt-5] [BalanceManager] token stuff";

    expect(parseStructuredLogLine(line)).toEqual({
      timestamp: "2026-08-27T13:00:01.000Z",
      level: "DEBUG",
      requestId: "a1b2c3d4",
      modelId: "gpt-5",
      isRouting: false,
    });
  });

  test("handles legacy lines that have a request id but no model tag", () => {
    const line =
      "[2026-08-27T13:00:02.000Z] [INFO] [req:deadbeef] Routing request with path: /v1/responses";

    expect(parseStructuredLogLine(line)).toEqual({
      timestamp: "2026-08-27T13:00:02.000Z",
      level: "INFO",
      requestId: "deadbeef",
      modelId: undefined,
      isRouting: true,
    });
  });

  test("extracts the bare request id from colon-joined legacy child tags", () => {
    const line =
      "[2026-08-27T13:00:04.000Z] [INFO] [req:deadbeef:RoutstrClient] [RoutstrClient] generic request pricing input {\"modelId\":\"deepseek-v4-flash-0731\"}";

    const parsed = parseStructuredLogLine(line);
    expect(parsed.requestId).toBe("deadbeef");
    expect(parsed.modelId).toBe("deepseek-v4-flash-0731");
    expect(parsed.isRouting).toBe(false);
  });

  test("falls back to the JSON modelId when no model tag is present", () => {
    const line =
      "[2026-08-27T13:00:05.000Z] [INFO] [req:deadbeef:RoutstrClient] [RoutstrClient] generic request pricing input {\"modelId\":\"deepseek-v4-pro-0813\",\"messageCount\":121}";

    expect(parseStructuredLogLine(line).modelId).toBe("deepseek-v4-pro-0813");
  });

  test("returns an empty record for plain non-request lines", () => {
    const line = "[2026-08-27T13:00:03.000Z] [WARN] Some startup message";

    expect(parseStructuredLogLine(line)).toEqual({
      timestamp: "2026-08-27T13:00:03.000Z",
      level: "WARN",
      requestId: undefined,
      modelId: undefined,
      isRouting: false,
    });
  });
});

describe("parseAutoModelPathArg", () => {
  test("reports the current setting when no state is given", () => {
    expect(parseAutoModelPathArg(undefined)).toEqual({ kind: "status" });
    expect(parseAutoModelPathArg("status")).toEqual({ kind: "status" });
    expect(parseAutoModelPathArg(" ")).toEqual({ kind: "status" });
  });

  test("accepts case-insensitive on/off spellings", () => {
    for (const raw of ["on", "ENABLE", " Enabled ", "true"]) {
      expect(parseAutoModelPathArg(raw)).toEqual({ kind: "set", enabled: true });
    }
    for (const raw of ["off", "Disable", "disabled", "false"]) {
      expect(parseAutoModelPathArg(raw)).toEqual({ kind: "set", enabled: false });
    }
  });

  test("recognises toggle separately from an explicit value", () => {
    expect(parseAutoModelPathArg("toggle")).toEqual({ kind: "toggle" });
  });

  test("rejects anything else instead of guessing", () => {
    // "yes"/"no"/"1" must not silently map onto on/off.
    expect(parseAutoModelPathArg("yes")).toEqual({
      kind: "invalid",
      value: "yes",
    });
    expect(parseAutoModelPathArg("1")).toEqual({ kind: "invalid", value: "1" });
  });
});

describe("formatAutoModelPathStatus", () => {
  test("reports the live value of a running daemon", () => {
    expect(
      formatAutoModelPathStatus({
        autoModelPath: true,
        configured: true,
        running: true,
      }),
    ).toEqual(["Automatic model-path selection: enabled"]);
  });

  test("warns when a hand-edited config.json disagrees with the daemon", () => {
    const lines = formatAutoModelPathStatus({
      autoModelPath: false,
      configured: true,
      running: true,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Automatic model-path selection: disabled");
    expect(lines[1]).toContain("config.json says enabled");
    expect(lines[1]).toContain("routstrd restart");
  });

  test("does not present a stopped daemon's file value as the live value", () => {
    expect(
      formatAutoModelPathStatus({
        autoModelPath: true,
        configured: true,
        running: false,
      }),
    ).toEqual([
      "Automatic model-path selection: enabled (configured; the daemon is not running)",
    ]);
  });
});

describe("collectRecentRequestsFromLines", () => {
  const lines = [
    "[2026-08-27T13:00:00.000Z] [INFO] [req:11111111] [model:gpt-5] Routing request with path: /a",
    "[2026-08-27T13:00:01.000Z] [DEBUG] [req:11111111] [model:gpt-5] [BalanceManager] token",
    "[2026-08-27T13:00:02.000Z] [INFO] [req:22222222] [model:claude-sonnet-4.5] Routing request with path: /b",
    "[2026-08-27T13:00:03.000Z] [DEBUG] [req:22222222] [model:claude-sonnet-4.5] [ModelManager] refresh",
  ];

  test("returns one record per request, newest first", () => {
    expect(collectRecentRequestsFromLines(lines, 10)).toEqual([
      {
        requestId: "22222222",
        modelId: "claude-sonnet-4.5",
        timestamp: "2026-08-27T13:00:02.000Z",
      },
      {
        requestId: "11111111",
        modelId: "gpt-5",
        timestamp: "2026-08-27T13:00:00.000Z",
      },
    ]);
  });

  test("respects the limit", () => {
    expect(collectRecentRequestsFromLines(lines, 1)).toEqual([
      {
        requestId: "22222222",
        modelId: "claude-sonnet-4.5",
        timestamp: "2026-08-27T13:00:02.000Z",
      },
    ]);
  });

  test("defaults the model to unknown for legacy routing lines", () => {
    const legacy = [
      "[2026-08-27T13:00:00.000Z] [INFO] [req:deadbeef] Routing request with path: /a",
    ];

    expect(collectRecentRequestsFromLines(legacy, 10)).toEqual([
      {
        requestId: "deadbeef",
        modelId: "unknown",
        timestamp: "2026-08-27T13:00:00.000Z",
      },
    ]);
  });

  test("enriches the model from a sibling pricing line in legacy logs", () => {
    const legacy = [
      "[2026-08-27T13:00:00.000Z] [INFO] [req:deadbeef] Routing request with path: /a",
      "[2026-08-27T13:00:01.000Z] [INFO] [req:deadbeef:RoutstrClient] [RoutstrClient] generic request pricing input {\"modelId\":\"deepseek-v4-flash-0731\"}",
    ];

    expect(collectRecentRequestsFromLines(legacy, 10)).toEqual([
      {
        requestId: "deadbeef",
        modelId: "deepseek-v4-flash-0731",
        timestamp: "2026-08-27T13:00:00.000Z",
      },
    ]);
  });
});

describe("initializeWallet", () => {
  test("creates the wallet directory and config with restrictive permissions", () => {
    const walletDir = join(makeTempDir(), "wallet");

    initializeWallet(walletDir);

    const walletConfig = join(walletDir, "config.json");
    expect(permissions(walletDir)).toBe(0o700);
    expect(permissions(walletConfig)).toBe(0o600);

    const config = JSON.parse(readFileSync(walletConfig, "utf8"));
    expect(config.encrypted).toBe(false);
    expect(typeof config.mnemonic).toBe("string");
    expect(config.mnemonic.length).toBeGreaterThan(0);
  });

  test("repairs permissions without replacing an existing wallet", () => {
    const walletDir = join(makeTempDir(), "wallet");
    const walletConfig = join(walletDir, "config.json");
    const existingConfig = JSON.stringify({ mnemonic: "existing seed" });

    mkdirSync(walletDir, { mode: 0o755 });
    writeFileSync(walletConfig, existingConfig, { mode: 0o644 });

    initializeWallet(walletDir);

    expect(readFileSync(walletConfig, "utf8")).toBe(existingConfig);
    expect(permissions(walletDir)).toBe(0o700);
    expect(permissions(walletConfig)).toBe(0o600);
  });
});

describe("offline settlement confirmation", () => {
  test("refuses non-interactive mark-spent without --yes before contacting the daemon", async () => {
    const proc = Bun.spawn([
      process.execPath, join(import.meta.dir, "index.ts"), "wallet", "send", "mark-spent", "test-operation",
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain("use --yes for non-interactive use");
  });
});


describe("offline sweep CLI", () => {
  const summary = { dryRun: false, minAgeMs: 604800000, candidates: 0, skipped: 0,
    stuck: 0, claimed: 0, reclaimed: 0, unresolved: 0, failed: 0, operations: [] };

  async function run(args: string[], output: Record<string, unknown> = summary) {
    const bodies: unknown[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => {
      if (new URL(req.url).pathname === "/health") return Response.json({ status: "ok" });
      bodies.push(await req.json());
      return Response.json({ output });
    } });
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ daemonUrl: server.url.origin, updateCheck: false }));
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), "wallet", "sweep-offline", ...args], {
        env: { ...process.env, ROUTSTRD_DIR: dir }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      return { stdout, stderr, exitCode, bodies };
    } finally { server.stop(true); }
  }

  test("refuses invalid ages and mint filters before contacting the daemon", async () => {
    for (const minAge of ["", "-1", "NaN", "Infinity", "1hour", "9999999999999999999"]) {
      const result = await run(["--min-age", minAge, "--yes"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --min-age");
      expect(result.bodies).toEqual([]);
    }
    for (const mint of ["", " ", "bad-url"]) {
      const result = await run(["--mint-url", mint, "--yes"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("mintUrl");
      expect(result.bodies).toEqual([]);
    }
  });

  test("requires consent without a TTY", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires confirmation");
    expect(result.bodies).toEqual([]);
  });

  test("parses fractional hours and normalizes filters for a local preview", async () => {
    const result = await run(["--dry-run", "--min-age", "0.25", "--mint-url", "HTTPS://MINT.EXAMPLE:443/"]);
    expect(result.exitCode).toBe(0);
    expect(result.bodies).toEqual([{ dryRun: true, confirmed: false, minAgeMs: 900000, mintUrl: "https://mint.example" }]);
    expect(result.stdout).toContain("not checked with mint");
    expect(result.stderr).toContain("No aged pending offline sends matched mint");
  });

  test("accepts explicit confirmation and defaults to seven days", async () => {
    const result = await run(["--yes"]);
    expect(result.exitCode).toBe(0);
    expect(result.bodies).toEqual([{ dryRun: false, confirmed: true, minAgeMs: 604800000 }]);
  });

  test("returns nonzero for failed, unresolved and stuck sends (including previews)", async () => {
    for (const kind of ["failed", "unresolved", "stuck"]) {
      const result = await run(["--yes"], { ...summary, [kind]: 1 });
      expect(result.exitCode).toBe(1);
    }
    const preview = await run(["--dry-run"], { ...summary, stuck: 1,
      operations: [{ operationId: "stuck-op", mintUrl: "https://mint.example", amount: 8, outcome: "stuck", error: "manual recovery via seed restore may be needed" }] });
    expect(preview.exitCode).toBe(1);
    expect(preview.stdout).toContain("stuck-op");
    expect(preview.stdout).toContain("seed restore");
  });

  test("rejects the removed cleanup --include-offline escape hatch", async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), "wallet", "cleanup", "--include-offline", "--yes"], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    expect(await new Response(proc.stderr).text()).toContain("unknown option '--include-offline'");
    expect(await proc.exited).toBe(1);
  });
});

describe("parseMonthlyLimitSats", () => {
  test("accepts whole non-negative numbers", () => {
    expect(parseMonthlyLimitSats("0")).toEqual({ value: 0 });
    expect(parseMonthlyLimitSats("5000")).toEqual({ value: 5000 });
    expect(parseMonthlyLimitSats("  1200  ")).toEqual({ value: 1200 });
  });

  test("omits the field when no limit was supplied", () => {
    expect(parseMonthlyLimitSats(undefined)).toEqual({});
  });

  test("rejects fractions, negatives and non-numeric values", () => {
    for (const raw of ["-1", "1.5", "1e3", "ten", "", " "]) {
      expect(parseMonthlyLimitSats(raw).error).toBeDefined();
    }
  });

  test("rejects values beyond the safe integer range", () => {
    expect(parseMonthlyLimitSats("9007199254740992").error).toBeDefined();
  });
});

describe("npubs add limit confirmation", () => {
  test("confirms a top-level proxy response and sends the requested limit", async () => {
    const result = await runAgainstProxy(["npubs", "add", TEST_NPUB, "--name", "Alice", "--limit-sats", "5000"], () =>
      Response.json({ npub: "npub-test", role: "user", added: true, monthlyLimitSats: 5000 }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Added npub: npub-test");
    expect(result.stdout).toContain("limit 5000 sats/month");
    expect(result.stderr).not.toContain("Warning");
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]!.body).toMatchObject({ name: "Alice", monthlyLimitSats: 5000 });
  });

  test("still requires a display name before posting", async () => {
    const result = await runAgainstProxy(["npubs", "add", TEST_NPUB, "--limit-sats", "5000"], () =>
      Response.json({ npub: "npub-test", role: "user", added: true, monthlyLimitSats: 5000 }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing required --name");
    expect(result.requests).toEqual([]);
  });

  test("warns when an older proxy does not confirm the limit", async () => {
    const result = await runAgainstProxy(["npubs", "add", TEST_NPUB, "--name", "Alice", "--limit-sats", "5000"], () =>
      Response.json({ npub: "npub-test", role: "user", added: true }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Added npub: npub-test");
    expect(result.stderr).toContain("did not confirm the monthly limit");
  });

  test("warns when the proxy reports the requested cap as unlimited", async () => {
    const result = await runAgainstProxy(["npubs", "add", TEST_NPUB, "--name", "Alice", "--limit-sats", "5000"], () =>
      Response.json({ npub: "npub-test", role: "user", added: true, monthlyLimitSats: null }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("was requested");
    expect(result.stdout).not.toContain("sats/month");
  });

  test("warns when the proxy reports a different cap", async () => {
    const result = await runAgainstProxy(["npubs", "add", TEST_NPUB, "--name", "Alice", "--limit-sats", "5000"], () =>
      Response.json({ npub: "npub-test", role: "user", added: true, monthlyLimitSats: 1000 }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("limit 1000 sats/month");
    expect(result.stderr).toContain("was requested");
  });

  test("stays quiet when no limit was requested", async () => {
    const result = await runAgainstProxy(["npubs", "add", TEST_NPUB, "--name", "Alice"], () =>
      Response.json({ npub: "npub-test", role: "user", added: true }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Warning");
    expect(result.requests[0]!.body).not.toHaveProperty("monthlyLimitSats");
  });
});

describe("npubs update monthly limit", () => {
  const updated = (monthlyLimitSats: number | null) =>
    Response.json({
      npub: "npub-test",
      pubkey: TEST_NPUB,
      name: null,
      role: "user",
      monthlyLimitSats,
    });

  test("sends and reports a numeric cap, including zero", async () => {
    for (const sats of [5000, 0]) {
      const result = await runAgainstProxy(
        ["npubs", "update", TEST_NPUB, "--limit-sats", String(sats)],
        () => updated(sats),
      );
      expect(result.exitCode).toBe(0);
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]!.method).toBe("PATCH");
      expect(result.requests[0]!.body).toMatchObject({ monthlyLimitSats: sats });
      expect(result.stdout).toContain(`limit=${sats} sats/month`);
      expect(result.stderr).not.toContain("Warning");
    }
  });

  test("--clear-limit sends an explicit null and reports unlimited", async () => {
    const result = await runAgainstProxy(["npubs", "update", TEST_NPUB, "--clear-limit"], () =>
      updated(null),
    );
    expect(result.exitCode).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]!.method).toBe("PATCH");
    const body = result.requests[0]!.body as {
      npub?: string;
      monthlyLimitSats?: number | null;
    };
    // An explicit null is what the proxy needs to clear the cap; omitting the
    // field would be read as "leave it alone".
    expect(body.monthlyLimitSats).toBeNull();
    expect(Object.keys(body).sort()).toEqual(["monthlyLimitSats", "npub"]);
    expect(result.stdout).toContain("limit=unlimited");
    expect(result.stderr).not.toContain("Warning");
  });

  test("rejects conflicting flags before contacting the proxy", async () => {
    const result = await runAgainstProxy(
      ["npubs", "update", TEST_NPUB, "--limit-sats", "5000", "--clear-limit"],
      () => updated(5000),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not both");
    expect(result.requests).toEqual([]);
  });

  test("rejects invalid limits before contacting the proxy", async () => {
    for (const raw of ["-1", "1.5", "ten"]) {
      const result = await runAgainstProxy(
        ["npubs", "update", TEST_NPUB, "--limit-sats", raw],
        () => updated(5000),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Invalid --limit-sats");
      expect(result.requests).toEqual([]);
    }
  });

  test("legacy proxy: warns and reports unknown instead of unlimited", async () => {
    const result = await runAgainstProxy(
      ["npubs", "update", TEST_NPUB, "--name", "Alice", "--limit-sats", "5000"],
      () => Response.json({ npub: "npub-test", pubkey: TEST_NPUB, name: "Alice", role: "user" }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("limit=unknown");
    expect(result.stdout).not.toContain("limit=unlimited");
    expect(result.stderr).toContain("did not confirm the monthly limit");
  });

  test("legacy proxy: reports unknown but does not warn when no limit was requested", async () => {
    const result = await runAgainstProxy(
      ["npubs", "update", TEST_NPUB, "--name", "Alice"],
      () => Response.json({ npub: "npub-test", pubkey: TEST_NPUB, name: "Alice", role: "user" }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("limit=unknown");
    expect(result.stderr).not.toContain("Warning");
  });

  test("warns when a requested cap comes back as a different value", async () => {
    const result = await runAgainstProxy(
      ["npubs", "update", TEST_NPUB, "--limit-sats", "5000"],
      () => updated(1000),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("limit=1000 sats/month");
    expect(result.stderr).toContain("was requested");
  });

  test("--clear-limit warns when the proxy keeps a numeric cap", async () => {
    const result = await runAgainstProxy(["npubs", "update", TEST_NPUB, "--clear-limit"], () =>
      updated(2000),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("limit=2000 sats/month");
    expect(result.stderr).toContain("but unlimited was requested");
  });

  test("--clear-limit warns when the proxy does not report a cap at all", async () => {
    const result = await runAgainstProxy(
      ["npubs", "update", TEST_NPUB, "--clear-limit"],
      () => Response.json({ npub: "npub-test", pubkey: TEST_NPUB, name: null, role: "user" }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("limit=unknown");
    expect(result.stderr).toContain("did not confirm the monthly limit");
  });
});

describe("npubs list monthly limits", () => {
  test("reports capped, unlimited and unknown caps", async () => {
    const result = await runAgainstProxy(["npubs", "list"], () =>
      Response.json({
        npubs: [
          { npub: "npub-capped", name: "Cap", role: "user", monthlyLimitSats: 5000, monthlyUsedSats: 1200 },
          { npub: "npub-free", name: null, role: "user", monthlyLimitSats: null },
          { npub: "npub-legacy", name: null, role: "admin" },
        ],
        monthlyResetAt: 1_790_000_000,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]!.method).toBe("GET");
    expect(result.stdout).toContain('npub-capped [user] "Cap" — limit: 5000 sats/month (1200 used)');
    expect(result.stdout).toContain("npub-free [user] (unnamed) — limit: unlimited");
    expect(result.stdout).toContain(
      "npub-legacy [admin] (unnamed) — limit: unknown (auth proxy does not report spend limits)",
    );
  });
});

/**
 * The npub is the one useful answer when a command has no node to talk to, so
 * these cases spawn the CLI with a config that has an identity but no
 * `daemonUrl`, exactly like a fresh local install.
 */
describe("npub shown without a remote node", () => {
  const secret = generateSecretKey();
  const nsec = nip19.nsecEncode(secret);
  const expectedNpub = npubFromSecretKey(secret);

  /** Run a command against a config dir holding `config.json` contents. */
  async function runWithConfig(
    args: string[],
    config: Record<string, unknown>,
  ) {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
      env: { ...process.env, ROUTSTRD_DIR: dir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  test("`npubs whoami` prints the npub and exits 0 with no remote node", async () => {
    const result = await runWithConfig(["npubs", "whoami"], { nsec });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(`Your npub: ${expectedNpub}`);
  });

  test("a bare `npubs` prints the npub above the usage block", async () => {
    const result = await runWithConfig(["npubs"], { nsec });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Your npub: ${expectedNpub}`);
    expect(result.stderr).toContain("Usage: routstrd npubs");
  });

  test("`npubs list` still refuses without a node, but names the npub to add", async () => {
    const result = await runWithConfig(["npubs", "list"], { nsec });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("npubs needs a remote node");
    expect(result.stderr).toContain(`Your npub: ${expectedNpub}`);
  });

  test("`remote` with no URL prints the npub alongside the setup hint", async () => {
    const result = await runWithConfig(["remote"], { nsec });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No remote node is set up.");
    expect(result.stderr).toContain(`Your npub: ${expectedNpub}`);
    expect(result.stderr).toContain("Pass a URL to set one up");
  });

  test("omits the line entirely when no identity is configured", async () => {
    for (const args of [["npubs", "whoami"], ["npubs"], ["remote"]]) {
      const result = await runWithConfig(args, { port: 8008 });
      expect(result.stdout).not.toContain("Your npub");
      expect(result.stderr).not.toContain("Your npub");
    }
  });
});

/**
 * A URL that is reachable but is not a routstrd daemon — the reported failure
 * was a Cloudron dashboard answering every path with its SPA. Before the probe,
 * `routstrd remote` saved such a URL and every later command died with Bun's
 * `JSON Parse error: Unrecognized token '<'`.
 */
describe("remote URL that is not a daemon", () => {
  const SPA = "<!DOCTYPE html>\n<html><body><div id=app></div></body></html>";

  /** Serve a fixed body/content-type for every request. */
  async function withServer(
    body: string,
    contentType: string,
    status: number,
    run: (origin: string) => Promise<void>,
  ): Promise<void> {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(body, { status, headers: { "content-type": contentType } }),
    });
    try {
      await run(server.url.origin);
    } finally {
      server.stop(true);
    }
  }

  async function runCli(args: string[], config: Record<string, unknown>) {
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
      env: { ...process.env, ROUTSTRD_DIR: dir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, configPath: join(dir, "config.json") };
  }

  test("`remote` refuses to save it and names the cause", async () => {
    await withServer(SPA, "text/html", 200, async (origin) => {
      const result = await runCli(["remote", origin], { updateCheck: false });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Refusing to set the remote daemon");
      expect(result.stderr).toContain("This looks like a web page, not a routstrd daemon");
      expect(result.stderr).toContain("--force");
      // Nothing was written, so the bad URL cannot leak into later commands.
      expect(JSON.parse(readFileSync(result.configPath, "utf-8")).daemonUrl).toBeUndefined();
    });
  });

  test("`remote --force` saves it without probing", async () => {
    await withServer(SPA, "text/html", 200, async (origin) => {
      const result = await runCli(["remote", origin, "--force"], { updateCheck: false });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Skipping the reachability probe");
      expect(JSON.parse(readFileSync(result.configPath, "utf-8")).daemonUrl).toBe(origin);
    });
  });

  test("`remote --force` does not wait on an unreachable host", async () => {
    // The flag exists for a host that cannot be reached from here, so probing
    // would only burn the full timeout before saving.
    const started = Date.now();
    const result = await runCli(["remote", "http://10.255.255.1:9", "--force"], {
      updateCheck: false,
    });

    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("`remote` still accepts a routstrd /health", async () => {
    await withServer('{"ok":true}', "application/json", 200, async (origin) => {
      const result = await runCli(["remote", origin], { updateCheck: false });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(result.configPath, "utf-8")).daemonUrl).toBe(origin);
    });
  });

  test("`remote` accepts a JSON 401 from an auth proxy", async () => {
    // The generated npub is unregistered until the operator adds it, so a JSON
    // rejection must not block setup.
    await withServer(
      '{"error":"Missing Authorization header."}',
      "application/json",
      401,
      async (origin) => {
        const result = await runCli(["remote", origin], { updateCheck: false });

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(result.configPath, "utf-8")).daemonUrl).toBe(origin);
      },
    );
  });

  test("a saved dashboard URL fails fast instead of mid-integration", async () => {
    // The regression: `clients add --pi-agent` used to print Bun's raw
    // "JSON Parse error: Unrecognized token '<'" with no hint about the URL.
    await withServer(SPA, "text/html", 200, async (origin) => {
      const result = await runCli(["clients", "add", "--pi-agent"], {
        daemonUrl: origin,
        updateCheck: false,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("This looks like a web page, not a routstrd daemon");
      expect(result.stderr).not.toContain("Unrecognized token");
    });
  });
});
