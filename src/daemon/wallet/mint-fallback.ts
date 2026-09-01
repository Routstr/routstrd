import type { CocodClient } from "./cocod-client";
import { logger } from "../../utils/logger";

export interface Bolt11InvoiceResult {
  invoice: string;
  mintUrl: string;
}

function uniqueMintUrls(mints: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const mint of mints) {
    const trimmed = mint?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function inspectForMintUnreachable(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/mint[_-]unreachable/i.test(trimmed) || /mint[_-]rate[_-]limited/i.test(trimmed) || /mint\b.*\bunreachable/i.test(trimmed)) return true;
    // Wallet-empty fallback: when the local wallet has no proofs, sendToken
    // throws "Not enough proofs to send" — treat this like an unreachable
    // mint so the fallback to the next configured mint kicks in.
    if (/not enough proofs/i.test(trimmed)) return true;
    // Network-level failures: "Failed to fetch mint <url>" (connection refused,
    // DNS failure, TLS error) — the mint is effectively unreachable.
    if (/failed to fetch/i.test(trimmed) || /failed to fetch mint/i.test(trimmed)) return true;
    // Generic fetch failures from the SDK's isNetworkErrorMessage set
    if (/networkerror when attempting to fetch resource/i.test(trimmed)) return true;
    if (/load failed/i.test(trimmed)) return true;

    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return inspectForMintUnreachable(JSON.parse(trimmed));
      } catch {
        return false;
      }
    }

    return false;
  }

  if (!value || typeof value !== "object") return false;

  if (value instanceof Error) {
    return inspectForMintUnreachable(value.message) ||
      inspectForMintUnreachable((value as Error & { cause?: unknown }).cause);
  }

  return Object.values(value).some((entry) => inspectForMintUnreachable(entry));
}

export function isMintUnreachableError(error: unknown): boolean {
  return inspectForMintUnreachable(error);
}

export async function receiveBolt11WithMintFallback(
  cocod: CocodClient,
  amount: number,
  mintUrls: string[],
  context: string,
): Promise<Bolt11InvoiceResult> {
  const candidates = uniqueMintUrls(mintUrls);
  if (candidates.length === 0) {
    throw new Error("No active mint configured");
  }

  let lastMintUnreachableError: unknown;
  for (const [index, mintUrl] of candidates.entries()) {
    try {
      if (index > 0) {
        logger.log(
          `${context} Retrying top-up with fallback mint ${mintUrl} (${index + 1}/${candidates.length})...`,
        );
      }
      const invoice = await cocod.receiveBolt11(amount, mintUrl);
      return { invoice, mintUrl };
    } catch (error) {
      if (!isMintUnreachableError(error)) {
        throw error;
      }

      lastMintUnreachableError = error;
      logger.warn(
        `${context} Mint unreachable while creating top-up invoice via ${mintUrl}.` +
          (index + 1 < candidates.length ? " Trying next configured mint." : " No fallback mints left."),
      );
    }
  }

  throw lastMintUnreachableError instanceof Error
    ? lastMintUnreachableError
    : new Error("All configured mints are unreachable");
}
