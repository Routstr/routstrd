import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MINT_URL,
  DEFAULT_TRUSTED_MINT_URLS,
  seedTrustedMints,
  type TrustedMintSeeder,
} from "./trusted-mints";

interface Harness {
  wallet: TrustedMintSeeder;
  added: string[];
  progress: string[];
  errors: { message: string; error: unknown }[];
}

function makeHarness(
  trustedMints: string[] = [],
  failing: string[] = [],
): Harness {
  const added: string[] = [];
  const progress: string[] = [];
  const errors: { message: string; error: unknown }[] = [];
  const wallet: TrustedMintSeeder = {
    trustedMints,
    addMint: async (mintUrl) => {
      if (failing.includes(mintUrl)) {
        throw new Error(`Failed to fetch mint ${mintUrl}`);
      }
      added.push(mintUrl);
    },
  };
  return { wallet, added, progress, errors };
}

describe("seedTrustedMints", () => {
  it("seeds every shipped mint for a wallet that trusts none", async () => {
    const { wallet, added, progress } = makeHarness();

    await seedTrustedMints(wallet, DEFAULT_MINT_URL, {
      onProgress: (message) => progress.push(message),
    });

    expect(added).toEqual([...DEFAULT_TRUSTED_MINT_URLS]);
    expect(progress).toEqual([
      `Adding default mint: ${DEFAULT_MINT_URL}`,
      "Adding trusted mint: https://mint.minibits.cash/Bitcoin",
    ]);
  });

  it("preserves the casing and path of seeded mint URLs", async () => {
    const { wallet, added } = makeHarness();

    await seedTrustedMints(wallet, DEFAULT_MINT_URL);

    // The Bitcoin path segment of the minibits mint is case sensitive;
    // lowercasing it breaks the mint.
    expect(added).toContain("https://mint.minibits.cash/Bitcoin");
  });

  it("skips mints that are already trusted", async () => {
    const { wallet, added } = makeHarness([
      DEFAULT_MINT_URL,
      "https://mint.minibits.cash/Bitcoin",
    ]);

    await seedTrustedMints(wallet, DEFAULT_MINT_URL);

    expect(added).toEqual([]);
  });

  it("treats a trailing slash on a stored mint as already trusted", async () => {
    const { wallet, added } = makeHarness([
      `${DEFAULT_MINT_URL}/`,
      "https://mint.minibits.cash/Bitcoin/",
    ]);

    await seedTrustedMints(wallet, DEFAULT_MINT_URL);

    expect(added).toEqual([]);
  });

  it("deduplicates the default mint when it also appears in the seeds", async () => {
    const { wallet, added } = makeHarness();

    await seedTrustedMints(wallet, DEFAULT_MINT_URL, {
      seeds: [DEFAULT_MINT_URL, DEFAULT_MINT_URL],
    });

    expect(added).toEqual([DEFAULT_MINT_URL]);
  });

  it("seeds the extras even when the wallet has a different default", async () => {
    const { wallet, added } = makeHarness();
    const customDefault = "https://mint.example.com";

    await seedTrustedMints(wallet, customDefault);

    // The wallet's own default stays first; the shipped seeds are added after
    // it and never take the default slot.
    expect(added).toEqual([
      customDefault,
      ...DEFAULT_TRUSTED_MINT_URLS.filter((url) => url !== customDefault),
    ]);
  });

  it("fails startup when the default mint cannot be fetched", async () => {
    const { wallet, added } = makeHarness([], [DEFAULT_MINT_URL]);

    await expect(
      seedTrustedMints(wallet, `${DEFAULT_MINT_URL}/`),
    ).rejects.toThrow(`Failed to fetch mint ${DEFAULT_MINT_URL}`);
    // The default is seeded first, so the extras were never attempted.
    expect(added).toEqual([]);
  });

  it("keeps going when a non-default mint cannot be fetched", async () => {
    const unavailable = "https://mint.minibits.cash/Bitcoin";
    const { wallet, added, errors } = makeHarness([], [unavailable]);

    await seedTrustedMints(wallet, DEFAULT_MINT_URL, {
      onError: (message, error) => errors.push({ message, error }),
    });

    expect(added).toEqual([DEFAULT_MINT_URL]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe(`Could not add trusted mint ${unavailable}`);
  });

  it("ignores stored mint URLs that cannot be normalized", async () => {
    const { wallet, added, errors } = makeHarness(["not a mint url"], []);

    await seedTrustedMints(wallet, DEFAULT_MINT_URL, {
      onError: (message, error) => errors.push({ message, error }),
    });

    expect(added).toEqual([...DEFAULT_TRUSTED_MINT_URLS]);
    expect(errors).toEqual([]);
  });
});