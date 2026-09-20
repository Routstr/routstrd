import { normalizeMintUrl } from "@cashu/coco-core";

/**
 * Mint used as the default for wallets that have no configured default. It is
 * always trusted, and a wallet is never allowed to point its default at a mint
 * it could not fetch.
 */
export const DEFAULT_MINT_URL = "https://mint.cubabitcoin.org";

/**
 * Mints routstrd trusts out of the box. Every entry is added as a trusted mint
 * on startup so users can send/receive without an explicit
 * `wallet mints add`. `DEFAULT_MINT_URL` is listed first because it seeds the
 * default mint of a fresh wallet; extra entries never change an existing
 * default.
 */
export const DEFAULT_TRUSTED_MINT_URLS: readonly string[] = [
  DEFAULT_MINT_URL,
  "https://mint.minibits.cash/Bitcoin",
];

export interface TrustedMintSeeder {
  /** Mint URLs the wallet currently trusts. */
  trustedMints: readonly string[];
  /** Trust a mint, fetching its info and keysets from the mint itself. */
  addMint: (mintUrl: string) => Promise<unknown>;
}

export interface SeedTrustedMintsOptions {
  /** Mints to ensure are trusted, in order. Defaults to the shipped seeds. */
  seeds?: readonly string[];
  /** Called before each mint fetch with a user-facing progress message. */
  onProgress?: (message: string) => void;
  /** Called when a non-default seed could not be added. */
  onError?: (message: string, error: unknown) => void;
}

// Stored and configured mint URLs come from SQLite and JSON, so a malformed
// value must never crash startup. Normalization only strips the default port
// and a trailing slash, so falling back to the raw string keeps comparisons
// meaningful.
function safeNormalizeMintUrl(mintUrl: string): string {
  try {
    return normalizeMintUrl(mintUrl);
  } catch {
    return mintUrl;
  }
}

/**
 * Ensure the mint seeds routstrd ships are trusted, without ever moving a
 * wallet's default away from `defaultMintUrl`.
 *
 * The default mint is seeded strictly: if it cannot be fetched the error is
 * rethrown, because persisting an unusable default is worse than failing
 * startup. Every other seed is best-effort — sending the mint fetch failure to
 * `onError` — so a single unreachable mint cannot keep the daemon down.
 */
export async function seedTrustedMints(
  wallet: TrustedMintSeeder,
  defaultMintUrl: string,
  options: SeedTrustedMintsOptions = {},
): Promise<void> {
  const seeds = options.seeds ?? DEFAULT_TRUSTED_MINT_URLS;
  const target = safeNormalizeMintUrl(defaultMintUrl);
  const trusted = new Set(wallet.trustedMints.map(safeNormalizeMintUrl));
  const attempted = new Set<string>();

  for (const seed of [defaultMintUrl, ...seeds]) {
    const mintUrl = safeNormalizeMintUrl(seed);
    if (attempted.has(mintUrl)) continue;
    attempted.add(mintUrl);
    if (trusted.has(mintUrl)) continue;

    const isDefault = mintUrl === target;
    try {
      options.onProgress?.(
        `Adding ${isDefault ? "default" : "trusted"} mint: ${mintUrl}`,
      );
      await wallet.addMint(mintUrl);
      trusted.add(mintUrl);
    } catch (error) {
      if (isDefault) throw error;
      options.onError?.(`Could not add trusted mint ${mintUrl}`, error);
    }
  }
}