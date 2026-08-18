import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  diagnoseWallets,
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

function writeFakeDbFile(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "coco.db"), "not a real sqlite database");
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
    CREATE TABLE coco_cashu_mints (mintUrl TEXT, trusted INTEGER);
    INSERT INTO coco_cashu_mints VALUES ('https://mint.example', 1);
    INSERT INTO coco_cashu_mints VALUES ('https://other.example', 1);
    INSERT INTO coco_cashu_mints VALUES ('https://third.example', 0);
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
    expect(diag.db.summary?.mints).toHaveLength(3);
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
    expect(err.message).toContain("routstrd stop");
    expect(err.message).not.toContain("abandon");
    expect(err.message).not.toContain("legal winner");
  });
});

describe("renderWalletDoctor", () => {
  it("reports different mnemonics as a conflict with resolution steps", () => {
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
    expect(report).toContain("mv \"");
  });

  it("reports matching mnemonics and warns startup still refuses", () => {
    const targetDir = join(root(), "wallet");
    const sourceDir = join(root(), ".cocod");
    writeWalletConfig(targetDir, { mnemonic: MNEMONIC_A });
    // Same mnemonic, but different bytes (extra metadata) — migration compares
    // files, not mnemonics, so startup still refuses.
    writeWalletConfig(sourceDir, {
      mnemonic: MNEMONIC_A,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const report = renderWalletDoctor(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(sourceDir, "legacy"),
    );
    expect(report).toContain("share the same mnemonic");
    expect(report).toContain("startup still refuses");
    expect(report).toContain("mv \"");
  });

  it("omits resolution steps when there is nothing to resolve", () => {
    const targetDir = join(root(), "wallet");
    const emptyDir = join(root(), ".cocod");
    writeWalletConfig(targetDir, { mnemonic: MNEMONIC_A });

    const report = renderWalletDoctor(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(emptyDir, "legacy"),
    );
    expect(report).toContain("no migration needed");
    expect(report).not.toContain("routstrd stop");
    expect(report).not.toContain("mv \"");
  });

  it("omits resolution steps for a fresh install", () => {
    const report = renderWalletDoctor(
      summarizeWalletDirectory(join(root(), "nope"), "canonical"),
      summarizeWalletDirectory(join(root(), "alsonope"), "legacy"),
    );
    expect(report).toContain("fresh install");
    expect(report).not.toContain("mv \"");
  });

  it("counts trusted mints from the mints table and formats amounts", () => {
    const targetDir = join(root(), "wallet");
    const sourceDir = join(root(), ".cocod");
    writeWalletConfig(targetDir, { mnemonic: MNEMONIC_A });
    writeWalletConfig(sourceDir, { mnemonic: MNEMONIC_B });
    writeProofsDb(sourceDir);

    const report = renderWalletDoctor(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(sourceDir, "legacy"),
    );
    // 3 registered mints, not the 2 mints that happen to hold proofs.
    expect(report).toContain("3 mints");
  });

  it("formats large balances with thousands separators", () => {
    const targetDir = join(root(), "wallet");
    const sourceDir = join(root(), ".cocod");
    writeWalletConfig(targetDir, { mnemonic: MNEMONIC_A });
    writeWalletConfig(sourceDir, { mnemonic: MNEMONIC_B });
    mkdirSync(sourceDir, { recursive: true });
    const db = new Database(join(sourceDir, "coco.db"));
    db.exec(`
      CREATE TABLE coco_cashu_proofs (mintUrl TEXT, state TEXT, amount INTEGER);
      INSERT INTO coco_cashu_proofs VALUES ('https://mint.example', 'ready', 21000);
    `);
    db.close();

    const report = renderWalletDoctor(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(sourceDir, "legacy"),
    );
    expect(report).toContain("ready: 21,000 sats");
  });
});

describe("diagnoseWallets", () => {
  it("flags conflicting mnemonics as a conflict needing resolution", () => {
    const targetDir = join(root(), "wallet");
    const sourceDir = join(root(), ".cocod");
    writeWalletConfig(targetDir, { mnemonic: MNEMONIC_A });
    writeWalletConfig(sourceDir, { mnemonic: MNEMONIC_B });

    const verdict = diagnoseWallets(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(sourceDir, "legacy"),
    );
    expect(verdict.conflict).toBe(true);
    expect(verdict.showResolution).toBe(true);
  });

  it("treats a single existing wallet as no conflict", () => {
    const targetDir = join(root(), "wallet");
    writeWalletConfig(targetDir, { mnemonic: MNEMONIC_A });

    const verdict = diagnoseWallets(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(join(root(), ".cocod"), "legacy"),
    );
    expect(verdict.conflict).toBe(false);
    expect(verdict.showResolution).toBe(false);
  });

  it("flags a legacy database without config as an incomplete conflict", () => {
    const sourceDir = join(root(), ".cocod");
    writeProofsDb(sourceDir);

    const verdict = diagnoseWallets(
      summarizeWalletDirectory(join(root(), "wallet"), "canonical"),
      summarizeWalletDirectory(sourceDir, "legacy"),
    );
    expect(verdict.conflict).toBe(true);
    expect(verdict.text).toContain("incomplete");
  });

  it("treats a stray legacy database as already-current when the canonical wallet exists", () => {
    const targetDir = join(root(), "wallet");
    const sourceDir = join(root(), ".cocod");
    writeWalletConfig(targetDir, { mnemonic: MNEMONIC_A });
    writeFakeDbFile(sourceDir);

    const verdict = diagnoseWallets(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(sourceDir, "legacy"),
    );
    expect(verdict.conflict).toBe(false);
    expect(verdict.showResolution).toBe(false);
  });

  it("flags an incomplete canonical database as a conflict", () => {
    const targetDir = join(root(), "wallet");
    writeFakeDbFile(targetDir);

    const verdict = diagnoseWallets(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(join(root(), ".cocod"), "legacy"),
    );
    expect(verdict.conflict).toBe(true);
    expect(verdict.showResolution).toBe(false);
  });

  it("flags orphaned legacy sidecars as a conflict", () => {
    const sourceDir = join(root(), ".cocod");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "coco.db-wal"), "wal");
    writeFileSync(join(sourceDir, "coco.db-shm"), "shm");

    const verdict = diagnoseWallets(
      summarizeWalletDirectory(join(root(), "wallet"), "canonical"),
      summarizeWalletDirectory(sourceDir, "legacy"),
    );
    expect(verdict.conflict).toBe(true);
    expect(verdict.showResolution).toBe(false);
  });

  it("treats byte-identical wallets as already-current", () => {
    const targetDir = join(root(), "wallet");
    const sourceDir = join(root(), ".cocod");
    writeWalletConfig(targetDir, { mnemonic: MNEMONIC_A });
    writeWalletConfig(sourceDir, { mnemonic: MNEMONIC_A });

    const verdict = diagnoseWallets(
      summarizeWalletDirectory(targetDir, "canonical"),
      summarizeWalletDirectory(sourceDir, "legacy"),
    );
    expect(verdict.conflict).toBe(false);
    expect(verdict.showResolution).toBe(false);
  });
});