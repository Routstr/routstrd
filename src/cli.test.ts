import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initializeWallet } from "./cli";

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
