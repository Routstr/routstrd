import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readWalletMnemonic } from "../../src/daemon/wallet/wallet-config";

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

describe("readWalletMnemonic", () => {
  test("returns the mnemonic from a valid config", () => {
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
