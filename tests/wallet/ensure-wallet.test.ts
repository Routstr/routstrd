import { TEST_ROOT } from "./test-env";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ensureLocalWallet } from "../../src/daemon/wallet/ensure-wallet";
import { readWalletMnemonic } from "../../src/daemon/wallet/wallet-config";
import { nsecFromMnemonic } from "../../src/utils/nip98";

// BIP-39 test mnemonic (same vector as tests/utils/nip98.test.ts).
const LEGACY_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
const LEGACY_DERIVED_NPUB =
  "npub1mx07p7jvpdf4g5lgatea9sgk6mjyfrld947k2nvmwmas94q6sjhssl4jwc";

// A different, checksum-valid BIP-39 mnemonic.
const OTHER_MNEMONIC = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

const ENV_KEYS = [
  "ROUTSTRD_WALLET_DIR",
  "COCOD_DIR",
  "COCOD_SOCKET",
  "COCOD_PID",
] as const;

const silent = { log: () => {}, warn: () => {} };

const savedEnv = new Map<string, string | undefined>();
const tempDirs: string[] = [];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "routstrd-ensure-wallet-"));
  tempDirs.push(root);
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  // paths.ts evaluates env lazily, so per-test overrides take effect at call
  // time. COCOD_SOCKET/COCOD_PID default under COCOD_DIR.
  process.env.ROUTSTRD_WALLET_DIR = join(root, "wallet");
  process.env.COCOD_DIR = join(root, "cocod");
  delete process.env.COCOD_SOCKET;
  delete process.env.COCOD_PID;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function writeLegacyWallet(mnemonic: string): void {
  const legacyDir = process.env.COCOD_DIR!;
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(
    join(legacyDir, "config.json"),
    JSON.stringify({ version: 1, mnemonic, encrypted: false }),
  );
}

describe("ensureLocalWallet", () => {
  test("creates a fresh wallet when neither canonical nor legacy wallets exist", async () => {
    const result = await ensureLocalWallet(silent);
    expect(result).toEqual({ migrated: false, created: true });

    const mnemonic = readWalletMnemonic();
    expect(mnemonic).not.toBeNull();
    expect(validateMnemonic(mnemonic!, wordlist)).toBe(true);
  });

  test("is idempotent: a second run keeps the same mnemonic", async () => {
    const first = await ensureLocalWallet(silent);
    expect(first.created).toBe(true);
    const mnemonic = readWalletMnemonic();

    const second = await ensureLocalWallet(silent);
    expect(second).toEqual({ migrated: false, created: false });
    expect(readWalletMnemonic()).toBe(mnemonic);
  });

  test("migrates a legacy cocod wallet and keeps its mnemonic", async () => {
    writeLegacyWallet(LEGACY_MNEMONIC);

    const result = await ensureLocalWallet(silent);
    expect(result).toEqual({ migrated: true, created: false });

    // The auth identity derives from the migrated wallet's mnemonic, not a
    // freshly generated one.
    expect(readWalletMnemonic()).toBe(LEGACY_MNEMONIC);
    expect(nsecFromMnemonic(readWalletMnemonic()!).npub).toBe(
      LEGACY_DERIVED_NPUB,
    );
  });

  test("refuses to shadow a legacy wallet with a divergent canonical wallet", async () => {
    const walletDir = process.env.ROUTSTRD_WALLET_DIR!;
    mkdirSync(walletDir, { recursive: true });
    writeFileSync(
      join(walletDir, "config.json"),
      JSON.stringify({ version: 1, mnemonic: OTHER_MNEMONIC, encrypted: false }),
    );
    writeLegacyWallet(LEGACY_MNEMONIC);

    await expect(ensureLocalWallet(silent)).rejects.toThrow(
      /Refusing to choose/,
    );

    // The pre-existing canonical wallet is left untouched.
    expect(readWalletMnemonic()).toBe(OTHER_MNEMONIC);
    expect(existsSync(join(walletDir, "config.json"))).toBe(true);
  });
});
