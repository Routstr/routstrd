import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateSecretKey, nip19 } from "nostr-tools";
import { DEFAULT_CONFIG } from "./config";
import { npubFromSecretKey } from "./nip98";
import { formatOwnNpub, formatOwnNpubSync } from "./own-npub";

const SECRET = generateSecretKey();
const NSEC = nip19.nsecEncode(SECRET);
const NPUB = npubFromSecretKey(SECRET);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write `contents` to a temp config.json and return its path. */
function tempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "routstrd-own-npub-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, contents);
  return path;
}

describe("formatOwnNpub", () => {
  test("renders the configured npub", () => {
    expect(formatOwnNpub({ ...DEFAULT_CONFIG, nsec: NSEC })).toBe(`Your npub: ${NPUB}`);
  });

  test("returns null without an identity", () => {
    expect(formatOwnNpub({ ...DEFAULT_CONFIG })).toBeNull();
  });

  test("returns null for an unparseable nsec instead of throwing", () => {
    expect(formatOwnNpub({ ...DEFAULT_CONFIG, nsec: "nsec1not-a-real-key" })).toBeNull();
  });
});

describe("formatOwnNpubSync", () => {
  test("reads the npub straight from the config file", () => {
    const path = tempConfig(JSON.stringify({ nsec: NSEC }));
    expect(formatOwnNpubSync(path)).toBe(`Your npub: ${NPUB}`);
  });

  test("returns null when the config file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "routstrd-own-npub-"));
    tempDirs.push(dir);
    expect(formatOwnNpubSync(join(dir, "missing.json"))).toBeNull();
  });

  test("returns null instead of throwing on a malformed config file", () => {
    expect(formatOwnNpubSync(tempConfig("{ not json"))).toBeNull();
  });

  test("returns null when the config has no identity", () => {
    expect(formatOwnNpubSync(tempConfig(JSON.stringify({ port: 8008 })))).toBeNull();
  });
});
