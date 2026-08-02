import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { migrateLegacyWallet } from "./migration";

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
  it("copies wallet data byte-for-byte and leaves process files behind", async () => {
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
    const database = new Uint8Array([0, 1, 2, 3, 255]);
    writeFileSync(join(legacyDir, "config.json"), config);
    writeFileSync(join(legacyDir, "coco.db"), database);
    writeFileSync(join(legacyDir, "cocod.pid"), "123");
    writeFileSync(join(legacyDir, "cocod.sock"), "not-a-real-socket");
    const assertStopped = mock(async () => {});
    const releaseLock = mock(() => {});
    const acquireLock = mock(() => releaseLock);

    const result = await migrateLegacyWallet({
      walletDir,
      legacyDir,
      assertLegacyStopped: assertStopped,
      acquireLegacyLock: acquireLock,
    });

    expect(result.status).toBe("migrated");
    expect(assertStopped).toHaveBeenCalledTimes(2);
    expect(acquireLock).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(walletDir, "config.json"), "utf8")).toBe(config);
    expect(readFileSync(join(walletDir, "coco.db"))).toEqual(Buffer.from(database));
    expect(statSync(walletDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(walletDir, "config.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(walletDir, "cocod.pid"))).toBe(false);
    expect(existsSync(join(walletDir, "cocod.sock"))).toBe(false);
    expect(existsSync(join(legacyDir, "config.json"))).toBe(false);
    expect(existsSync(join(legacyDir, "coco.db"))).toBe(false);
    expect(existsSync(join(legacyDir, "cocod.pid"))).toBe(true);
    expect(existsSync(join(legacyDir, "cocod.sock"))).toBe(true);
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

  it("refuses when both canonical and legacy configs exist", async () => {
    const base = root();
    const legacyDir = join(base, ".cocod");
    const walletDir = join(base, ".routstrd", "wallet");
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(walletDir, { recursive: true });
    writeFileSync(join(legacyDir, "config.json"), "legacy");
    writeFileSync(join(walletDir, "config.json"), "current");

    await expect(migrateLegacyWallet({ walletDir, legacyDir })).rejects.toThrow(
      "both",
    );
    expect(readFileSync(join(walletDir, "config.json"), "utf8")).toBe("current");
    expect(readFileSync(join(legacyDir, "config.json"), "utf8")).toBe("legacy");
  });
});
