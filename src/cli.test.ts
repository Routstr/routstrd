import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  collectRecentRequestsFromLines,
  initializeWallet,
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
