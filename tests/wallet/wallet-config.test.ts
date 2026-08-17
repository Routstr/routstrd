import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  initializeWallet,
  readWalletMnemonic,
} from "../../src/daemon/wallet/wallet-config";

const MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

const tempDirs: string[] = [];

function makeWalletDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-wallet-config-"));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, config: unknown): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readWalletMnemonic", () => {  test("returns the mnemonic from a valid config", () => {
    const dir = makeWalletDir();
    writeConfig(dir, { version: 1, mnemonic: MNEMONIC, encrypted: false });

    expect(readWalletMnemonic(dir)).toBe(MNEMONIC);
  });

  test("returns null when the wallet is not initialized", () => {
    const dir = makeWalletDir();
    expect(readWalletMnemonic(dir)).toBeNull();
  });

  test("returns null for an encrypted wallet", () => {
    const dir = makeWalletDir();
    writeConfig(dir, { version: 1, mnemonic: MNEMONIC, encrypted: true });

    expect(readWalletMnemonic(dir)).toBeNull();
  });

  test("returns null when the mnemonic field is missing", () => {
    const dir = makeWalletDir();
    writeConfig(dir, { version: 1, encrypted: false });

    expect(readWalletMnemonic(dir)).toBeNull();
  });

  test("returns null for a malformed config file", () => {
    const dir = makeWalletDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{not valid json");

    expect(readWalletMnemonic(dir)).toBeNull();
  });

  test("trims surrounding whitespace from the mnemonic", () => {
    const dir = makeWalletDir();
    writeConfig(dir, {
      version: 1,
      mnemonic: `  ${MNEMONIC}  `,
      encrypted: false,
    });

    expect(readWalletMnemonic(dir)).toBe(MNEMONIC);
  });
});

describe("initializeWallet", () => {
  const silent = () => {};

  function permissions(path: string): number {
    return statSync(path).mode & 0o777;
  }

  test("creates the wallet with a valid BIP-39 mnemonic and restrictive permissions", () => {
    const dir = join(makeWalletDir(), "wallet");

    expect(initializeWallet(dir, silent)).toBe(true);

    expect(permissions(dir)).toBe(0o700);
    const configPath = join(dir, "config.json");
    expect(permissions(configPath)).toBe(0o600);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.version).toBe(1);
    expect(config.encrypted).toBe(false);
    expect(validateMnemonic(config.mnemonic, wordlist)).toBe(true);
    expect(readWalletMnemonic(dir)).toBe(config.mnemonic);
  });

  test("keeps the existing mnemonic on repeat calls", () => {
    const dir = join(makeWalletDir(), "wallet");
    initializeWallet(dir, silent);
    const first = readWalletMnemonic(dir);

    expect(initializeWallet(dir, silent)).toBe(false);
    expect(readWalletMnemonic(dir)).toBe(first);
  });

  test("repairs permissions without replacing an existing wallet", () => {
    const dir = join(makeWalletDir(), "wallet");
    const configPath = join(dir, "config.json");
    const existingConfig = JSON.stringify({ mnemonic: "existing seed" });

    mkdirSync(dir, { mode: 0o755 });
    writeFileSync(configPath, existingConfig, { mode: 0o644 });

    expect(initializeWallet(dir, silent)).toBe(false);

    expect(readFileSync(configPath, "utf8")).toBe(existingConfig);
    expect(permissions(dir)).toBe(0o700);
    expect(permissions(configPath)).toBe(0o600);
  });
});
