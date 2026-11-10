import { afterEach, describe, expect, test } from "bun:test";
import { generateSecretKey, nip19 } from "nostr-tools";
import { DEFAULT_CONFIG } from "./config";
import { npubFromSecretKey } from "./nip98";
import { formatOwnNpub } from "./own-npub";

const SECRET = generateSecretKey();
const NSEC = nip19.nsecEncode(SECRET);
const NPUB = npubFromSecretKey(SECRET);

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
