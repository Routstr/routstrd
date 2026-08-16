import { describe, expect, test } from "bun:test";
import { getPublicKey, nip19 } from "nostr-tools";
import {
  AUTH_NOSTR_ACCOUNT_INDEX,
  nsecFromMnemonic,
  parseSecretKey,
} from "../../src/utils/nip98";

// BIP-39 test mnemonic from the spec. Reference values derived with the same
// nostr-tools / @scure/bip39 stack the project uses.
const MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

const ACCOUNT_0 = {
  nsec: "nsec1pcxghvh7hgr6dery5eampqdgjwplnuqh4gu470v6hk7ugcgcty3q26maau",
  npub: "npub1mx07p7jvpdf4g5lgatea9sgk6mjyfrld947k2nvmwmas94q6sjhssl4jwc",
  pubkey: "d99fe0fa4c0b535453e8eaf3d2c116d6e4448fed2d7d654d9b76fb02d41a84af",
};

const ACCOUNT_1 = {
  nsec: "nsec12wejnr55hhl7wds0f0lzgmvad6s3r786hekrwnf7vt9yyt9vu4gsfe59ve",
  npub: "npub1lj3rmlalqw3kuj5swhj9mpqyw3d4lgcs65ndmd4ee8h20azpvgwqjqkd6x",
  pubkey: "fca23dffbf03a36e4a9075e45d8404745b5fa310d526ddb6b9c9eea7f441621c",
};

describe("nsecFromMnemonic", () => {
  test("uses NIP-06 account index 0 by default", () => {
    expect(AUTH_NOSTR_ACCOUNT_INDEX).toBe(0);

    const { nsec, npub } = nsecFromMnemonic(MNEMONIC);
    expect(nsec).toBe(ACCOUNT_0.nsec);
    expect(npub).toBe(ACCOUNT_0.npub);
  });

  test("matches the reference account index 0 vector", () => {
    const identity = nsecFromMnemonic(MNEMONIC, 0);
    expect(identity.secretKey).toHaveLength(32);
    expect(identity.nsec).toBe(ACCOUNT_0.nsec);
    expect(identity.npub).toBe(ACCOUNT_0.npub);
    expect(getPublicKey(identity.secretKey)).toBe(ACCOUNT_0.pubkey);
  });

  test("derives a distinct key for a different account index", () => {
    const identity = nsecFromMnemonic(MNEMONIC, 1);
    expect(identity.nsec).toBe(ACCOUNT_1.nsec);
    expect(identity.npub).toBe(ACCOUNT_1.npub);
    expect(getPublicKey(identity.secretKey)).toBe(ACCOUNT_1.pubkey);

    expect(identity.nsec).not.toBe(ACCOUNT_0.nsec);
    expect(identity.npub).not.toBe(ACCOUNT_0.npub);
  });

  test("is deterministic", () => {
    expect(nsecFromMnemonic(MNEMONIC)).toEqual(nsecFromMnemonic(MNEMONIC));
  });

  test("round-trips through parseSecretKey and nip19", () => {
    const { secretKey, nsec, npub } = nsecFromMnemonic(MNEMONIC);

    expect(parseSecretKey(nsec)).toEqual(secretKey);
    expect(nip19.nsecEncode(secretKey)).toBe(nsec);

    const decoded = nip19.decode(npub);
    expect(decoded.type).toBe("npub");
    expect(decoded.data).toBe(getPublicKey(secretKey));
  });
});
