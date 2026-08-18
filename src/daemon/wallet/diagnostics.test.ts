import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  mnemonicFingerprint,
  renderWalletDoctor,
  summarizeWalletDirectory,
  WalletMigrationConflictError,
} from "./diagnostics";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "routstrd-diagnostics-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const MNEMONIC_A =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_B =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

function writeWalletConfig(dir: string, config: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

function writeProofsDb(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "coco.db"));
  db.exec(`
    CREATE TABLE coco_cashu_proofs (mintUrl TEXT, state TEXT, amount INTEGER);
    INSERT INTO coco_cashu_proofs VALUES ('https://mint.example', 'ready', 100);
    INSERT INTO coco_cashu_proofs VALUES ('https://mint.example', 'ready', 50);
    INSERT INTO coco_cashu_proofs VALUES ('https://mint.example', 'pending', 30);
    INSERT INTO coco_cashu_proofs VALUES ('https://other.example', 'spent', 20);
  `);
  db.close();
}

describe("mnemonicFingerprint", () => {
  it("is deterministic and normalizes whitespace", () => {
    const base = mnemonicFingerprint(MNEMONIC_A);
    expect(mnemonicFingerprint(MNEMONIC_A)).toBe(base);
    expect(
      mnemonicFingerprint("  abandon abandon   abandon abandon abandon abandon abandon abandon abandon abandon abandon about "),
    ).toBe(base);
  });

  it("distinguishes different mnemonics and never returns the mnemonic", () => {
    const a = mnemonicFingerprint(MNEMONIC_A);
    const b = mnemonicFingerprint(MNEMONIC_B);
    expect(a).not.toBe(b);
    expect(a).not.toContain("abandon");
    expect(b).not.toContain("legal");
  });
});

describe("summarizeWalletDirectory", () => {
  it("reports an empty directory", () => {
    const dir = join(root(), "empty");
    const diag = summarizeWalletDirectory(dir, "canonical");
    expect(diag.config.exists).toBe(false);
    expect(diag.db.exists).toBe(false);
  });

  it("summarizes a decrypted config with fingerprint and metadata", () => {
    const dir = join(root(), "wallet");
    writeWalletConfig(dir, {
      version: 1,
      mnemonic: MNEMONIC_A,
      encrypted: false,
      createdAt: "2026-08-20T14:03:22.000Z",
      defaultMintUrl: "https://mint.example",
    });
    const diag = summarizeWalletDirectory(dir, "canonical");
    expect(diag.config.exists).toBe(true);
    expect(diag.config.fingerprint).toBe(mnemonicFingerprint(MNEMONIC_A));
    expect(diag.config.hasMnemonic).toBe(true);
    expect(diag.config.encrypted).toBe(false);
    expect(diag.config.createdAt).toBe("2026-08-20T14:03:22.000Z");
    expect(diag.config.defaultMintUrl).toBe("https://mint.example");
    expect(diag.config.mtimeMs).toBeTypeOf("number");
  });

  it("does not derive a fingerprint for encrypted wallets", () => {
    const dir = join(root(), "encrypted");
    writeWalletConfig(dir, { mnemonic: MNEMONIC_A, encrypted: true });
    const diag = summarizeWalletDirectory(dir, "canonical");
    expect(diag.config.exists).toBe(true);
    expect(diag.config.encrypted).toBe(true);
    expect(diag.config.fingerprint).toBeUndefined();
  });

  it("degrades gracefully when config.json is malformed", () => {
    const dir = join(root(), "bad-config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "not json");
    const diag = summarizeWalletDirectory(dir, "canonical");
    expect(diag.config.exists).toBe(true);
    expect(diag.config.error).toBeTruthy();
    expect(diag.config.fingerprint).toBeUndefined();
  });

  it("summarizes a proof database without opening it read-write", () => {
    const dir = join(root(), "with-db");
    writeProofsDb(dir);
    const diag = summarizeWalletDirectory(dir, "canonical");
    expect(diag.db.exists).toBe(true);
    expect(diag.db.summary).toBeDefined();
    expect(diag.db.summary?.totalProofs).toBe(4);
    expect(diag.db.summary?.totalAmount).toBe(200);
    expect(diag.db.summary?.distinctMints).toBe(2);
    expect(diag.db.summary?.amountByState).toEqual({
      ready: 150,
      pending: 30,
      spent: 20,
    });
  });
});

describe("WalletMigrationConflictError", () => {
  it("renders a structured conflict message without leaking mnemonics", () => {
    const targetDir = join(root(), "wallet");
    const sourceDir = join(root(), ".cocod");
    writeWalletConfig(targetDir, { mnemonic: MNEMONIC_A });
    writeWalletConfig(sourceDir, { mnemonic: MNEMONIC_B });

    const err = new WalletMigrationConflictError(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(sourceDir, "legacy"),
    );
    expect(err.target.dir).toBe(targetDir);
    expect(err.source.dir).toBe(sourceDir);
    expect(err.message).toContain(targetDir);
    expect(err.message).toContain(sourceDir);
    expect(err.message).toContain("routstrd wallet doctor");
    expect(err.message).not.toContain("abandon");
    expect(err.message).not.toContain("legal winner");
  });
});

describe("renderWalletDoctor", () => {
  it("reports different mnemonics as a conflict", () => {
    const targetDir = join(root(), "wallet");
    const sourceDir = join(root(), ".cocod");
    writeWalletConfig(targetDir, { mnemonic: MNEMONIC_A });
    writeWalletConfig(sourceDir, { mnemonic: MNEMONIC_B });

    const report = renderWalletDoctor(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(sourceDir, "legacy"),
    );
    expect(report).toContain("DIFFERENT mnemonics");
    expect(report).toContain("routstrd stop");
  });

  it("reports matching mnemonics", () => {
    const targetDir = join(root(), "wallet");
    const sourceDir = join(root(), ".cocod");
    writeWalletConfig(targetDir, { mnemonic: MNEMONIC_A });
    writeWalletConfig(sourceDir, { mnemonic: MNEMONIC_A });

    const report = renderWalletDoctor(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(sourceDir, "legacy"),
    );
    expect(report).toContain("share the same mnemonic");
  });
});