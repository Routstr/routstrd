import { afterEach, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { migrateLegacyWallet } from "./migration";
import { WalletMigrationConflictError } from "./diagnostics";

const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "routstrd-migration-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("migrateLegacyWallet", () => {
  it("snapshots committed WAL data and leaves process files behind", async () => {
    const base = root();
    const legacyDir = join(base, ".cocod");
    const walletDir = join(base, ".routstrd", "wallet");
    mkdirSync(legacyDir);
    const config = JSON.stringify({
      mnemonic: "seed words",
      encrypted: false,
      defaultMintUrl: "https://mint.example",
      unknown: { preserved: true },
    });
    writeFileSync(join(legacyDir, "config.json"), config);
    writeFileSync(join(legacyDir, "cocod.pid"), "123");
    writeFileSync(join(legacyDir, "cocod.sock"), "not-a-real-socket");

    const source = new Database(join(legacyDir, "coco.db"));
    source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    source.exec(`
      CREATE TABLE coco_cashu_proofs (mintUrl TEXT, state TEXT, amount INTEGER);
      CREATE TABLE coco_cashu_counters (mintUrl TEXT, keysetId TEXT, counter INTEGER);
      CREATE TABLE coco_cashu_mint_operations (state TEXT);
      CREATE TABLE coco_cashu_send_operations (state TEXT);
      CREATE TABLE coco_cashu_melt_operations (state TEXT);
      CREATE TABLE coco_cashu_mints (mintUrl TEXT, trusted INTEGER);
      INSERT INTO coco_cashu_proofs VALUES ('https://mint.example', 'ready', 21);
      INSERT INTO coco_cashu_counters VALUES ('https://mint.example', 'keyset', 3);
      INSERT INTO coco_cashu_mints VALUES ('https://mint.example', 1);
    `);
    expect(existsSync(join(legacyDir, "coco.db-wal"))).toBe(true);

    const assertStopped = mock(async () => {});
    const releaseLock = mock(() => {});
    const acquireLock = mock(() => releaseLock);
    const result = await migrateLegacyWallet({
      walletDir,
      legacyDir,
      assertLegacyStopped: assertStopped,
      acquireLegacyLock: acquireLock,
    });
    source.close();

    expect(result.status).toBe("migrated");
    expect(assertStopped).toHaveBeenCalledTimes(2);
    expect(acquireLock).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(walletDir, "config.json"), "utf8")).toBe(config);
    const migrated = new Database(join(walletDir, "coco.db"), { readonly: true });
    expect(migrated.query("PRAGMA quick_check").values()).toEqual([["ok"]]);
    expect(migrated.query("SELECT state, amount FROM coco_cashu_proofs").values()).toEqual([
      ["ready", 21],
    ]);
    expect(migrated.query("SELECT counter FROM coco_cashu_counters").get()).toEqual({
      counter: 3,
    });
    migrated.close();
    expect(existsSync(join(walletDir, "coco.db-wal"))).toBe(false);
    expect(statSync(walletDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(walletDir, "config.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(walletDir, "cocod.pid"))).toBe(false);
    expect(existsSync(join(walletDir, "cocod.sock"))).toBe(false);
    expect(existsSync(join(legacyDir, "config.json"))).toBe(false);
    expect(existsSync(join(legacyDir, "coco.db"))).toBe(false);
    expect(existsSync(join(legacyDir, "cocod.pid"))).toBe(true);
    expect(existsSync(join(legacyDir, "cocod.sock"))).toBe(true);
    const archive = readdirSync(legacyDir).find((name) => name.startsWith("wallet-migrated-"));
    expect(archive).toBeDefined();
    expect(existsSync(join(legacyDir, archive!, "config.json"))).toBe(true);
    expect(existsSync(join(legacyDir, archive!, "coco.db"))).toBe(true);
  });

  it("treats a config-only initialized wallet as migratable", async () => {
    const base = root();
    const legacyDir = join(base, ".cocod");
    const walletDir = join(base, ".routstrd", "wallet");
    mkdirSync(legacyDir);
    writeFileSync(join(legacyDir, "config.json"), '{"mnemonic":"seed"}');

    expect((await migrateLegacyWallet({ walletDir, legacyDir })).status).toBe("migrated");
    expect(existsSync(join(walletDir, "config.json"))).toBe(true);
    expect(existsSync(join(walletDir, "coco.db"))).toBe(false);
  });

  it("refuses a database without its mnemonic config", async () => {
    const base = root();
    const legacyDir = join(base, ".cocod");
    mkdirSync(legacyDir);
    writeFileSync(join(legacyDir, "coco.db"), "database");

    await expect(migrateLegacyWallet({ walletDir: join(base, "wallet"), legacyDir })).rejects.toThrow(
      "without config.json",
    );
  });

  it("refuses orphaned SQLite sidecars", async () => {
    const base = root();
    const legacyDir = join(base, ".cocod");
    mkdirSync(legacyDir);
    writeFileSync(join(legacyDir, "coco.db-wal"), "orphaned WAL");

    await expect(migrateLegacyWallet({ walletDir: join(base, "wallet"), legacyDir })).rejects.toThrow(
      "sidecar files without coco.db",
    );
  });

  it("refuses when both canonical and legacy configs exist", async () => {
    const base = root();
    const legacyDir = join(base, ".cocod");
    const walletDir = join(base, ".routstrd", "wallet");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(walletDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "config.json"),
      JSON.stringify({ mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" }),
    );
    writeFileSync(
      join(walletDir, "config.json"),
      JSON.stringify({ mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow" }),
    );

    let thrown: unknown;
    try {
      await migrateLegacyWallet({ walletDir, legacyDir });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WalletMigrationConflictError);
    const err = thrown as WalletMigrationConflictError;
    expect(err.target.dir).toBe(walletDir);
    expect(err.source.dir).toBe(legacyDir);
    expect(err.message).toContain("two different wallets were found");
    expect(err.message).toContain(walletDir);
    expect(err.message).toContain(legacyDir);
    expect(err.message).not.toContain("abandon");
    expect(err.message).not.toContain("legal winner");
    expect(readFileSync(join(walletDir, "config.json"), "utf8")).toContain(
      "legal winner",
    );
    expect(readFileSync(join(legacyDir, "config.json"), "utf8")).toContain(
      "abandon abandon",
    );
  });
});
