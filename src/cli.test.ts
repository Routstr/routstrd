import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
  async function run(legacy: boolean) {
    const bodies: unknown[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => {
      if (new URL(req.url).pathname === "/health") return Response.json({ status: "ok" });
      bodies.push(await req.json());
      return Response.json({ npub: "npub-test", role: "user", added: true,
        ...(legacy ? {} : { monthlyLimitSats: 5000 }) });
    } });
    const dir = makeTempDir();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ daemonUrl: server.url.origin, updateCheck: false }));
    try {
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"),
        "npubs", "add", "ab".repeat(32), "--limit-sats", "5000"], {
        env: { ...process.env, ROUTSTRD_DIR: dir }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      return { stdout, stderr, exitCode, bodies };
    } finally { server.stop(true); }
  }

  test("confirms a top-level proxy response and sends the requested limit", async () => {
    const result = await run(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Added npub: npub-test");
    expect(result.stdout).toContain("limit 5000 sats/month");
    expect(result.stderr).not.toContain("did not confirm");
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]).toMatchObject({ monthlyLimitSats: 5000 });
  });

  test("warns when an older proxy does not confirm the limit", async () => {
    const result = await run(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Added npub: npub-test");
    expect(result.stderr).toContain("did not confirm the monthly limit");
  });
});
