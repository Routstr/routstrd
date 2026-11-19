import {
  getDecodedToken,
  getEncodedToken,
  getTokenMetadata,
  type Proof,
} from "@cashu/cashu-ts";
import { logger } from "../../utils/logger";

type Unit = "sat" | "msat";

export interface ParkedTokenSpender {
  receiveToken(
    token: string,
    cacheOnFailure?: boolean,
  ): Promise<{
    success: boolean;
    amount: number;
    unit: Unit;
    message?: string;
  }>;
}

export interface ParkedTokenSource {
  getCashuSpender(): ParkedTokenSpender;
}

export interface ParkedTokenEntry {
  token: string;
  amount: number;
  unit: Unit;
  createdAt: number;
}

export interface ParkedTokenStorage {
  getCachedReceiveTokens(): ParkedTokenEntry[];
  setCachedReceiveTokens(tokens: ParkedTokenEntry[]): void;
}

export type ParkedDropReason = "undecodable" | "already-spent";

export interface ParkedDrop {
  reason: ParkedDropReason;
  amount: number;
  unit: Unit;
  mint?: string;
}

export interface ParkedTokenRecovery {
  /** Receives attempted using the original token, excluding merged receives. */
  attempted: number;
  /** Parked entries received, including the constituent entries of merged receives. */
  succeeded: number;
  /** Parked entries present at the start of the run. */
  parked: number;
  /** Remaining entries according to the last confirmed prune. */
  remaining: number;
  /** Input face value, not net wallet credit after fees. */
  recoveredFaceValue: Record<Unit, number>;
  /** Entries removed without a successful receive; excludes unconfirmed writes. */
  dropped: ParkedDrop[];
  batches: number;
  batchesRecovered: number;
  error?: string;
  pruneError?: string;
}

export interface ParkedTokenRecoveryOptions {
  flush?: () => Promise<void>;
  /** Only include secrets whose spent state was explicitly confirmed by the mint. */
  checkSpent?: (
    mint: string,
    proofs: { id: string; secret: string }[],
  ) => Promise<ReadonlySet<string>>;
}

interface Inspection {
  entry: ParkedTokenEntry;
  mint?: string;
  unit: Unit;
  amount: number;
  proofCount: number;
  /** Missing for malformed tokens and tokens requiring the mint's keysets. */
  proofs?: Proof[];
  undecodable?: true;
}

function inspect(entry: ParkedTokenEntry, decodeProofs = false): Inspection {
  let metadata: ReturnType<typeof getTokenMetadata>;
  try {
    metadata = getTokenMetadata(entry.token);
  } catch {
    return { entry, unit: entry.unit, amount: entry.amount, proofCount: 0, undecodable: true };
  }
  const result: Inspection = {
    entry,
    mint: metadata.mint,
    unit: metadata.unit === "msat" || metadata.unit === "sat" ? metadata.unit : entry.unit,
    amount: metadata.amount.isSafeNumber() ? metadata.amount.toNumber() : entry.amount,
    proofCount: metadata.incompleteProofs.length,
  };
  if (!decodeProofs || (metadata.unit !== "sat" && metadata.unit !== "msat")) return result;
  try {
    result.proofs = getDecodedToken(entry.token, []).proofs;
  } catch {
    // A valid v4 short keyset ID requires the full mint keyset list. Do not
    // merge or prune based on offline decoding; let the wallet try the original.
  }
  return result;
}

/** Only use recognisable swap replies to decide whether to check proof states. */
function classifyFailure(message?: string): "spent" | "fee" | "other" {
  if (/^(?:proofs?|token)(?: (?:is|are|was|were))? already spent[.!]?$/i.test(message?.trim() ?? "")) {
    return "spent";
  }
  if (/^(?:receive amount is not sufficient after fees|no outputs provided)[.!]?$/i.test(message?.trim() ?? "")) {
    return "fee";
  }
  return "other";
}

/** Common network failures should stop further mint attempts for this sweep. */
function isUnavailable(message?: string): boolean {
  return /failed to fetch|fetch failed|network(?: error| request failed| timeout)|timed?\s*out|timeout|connection (?:refused|reset)|econn(?:refused|reset)|enotfound|eai_again|service unavailable/i.test(message ?? "");
}

function groupKey(entry: Inspection): string {
  return `${entry.mint}\u0000${entry.unit}`;
}

function merge(entries: Inspection[]): string | undefined {
  const first = entries[0];
  if (!first?.mint) return;
  const seen = new Set<string>();
  const proofs: Proof[] = [];
  try {
    for (const entry of entries) {
      if (!entry.proofs || groupKey(entry) !== groupKey(first)) return;
      for (const proof of entry.proofs) {
        // Do not build a swap with duplicate inputs. Retry originals instead.
        if (seen.has(proof.secret)) return;
        seen.add(proof.secret);
        // V4 decoding returns a string, but V4 encoding JSON-serializes the
        // witness. Pass the object back in to avoid encoding it twice.
        if (typeof proof.witness === "string") {
          const witness: unknown = JSON.parse(proof.witness);
          if (!witness || typeof witness !== "object" || Array.isArray(witness)) return;
          proofs.push({ ...proof, witness: witness as Proof["witness"] });
        } else {
          proofs.push(proof);
        }
      }
    }
    return getEncodedToken({ mint: first.mint, unit: first.unit, proofs });
  } catch {
    // Preserve the original when it cannot be re-encoded intact.
    return;
  }
}

function publicMint(mint?: string): string | undefined {
  if (!mint) return;
  try {
    const url = new URL(mint);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    // Serialized metadata should not contain credentials or opaque URL parameters.
    if (url.username || url.password || url.search || url.hash) return;
    return mint;
  } catch {
    return;
  }
}

function metadataFor(entry: Inspection) {
  const mint = publicMint(entry.mint);
  return { amount: entry.amount, unit: entry.unit, ...(mint ? { mint } : {}) };
}

const activeSweeps = new WeakMap<ParkedTokenStorage, Promise<ParkedTokenRecovery>>();

/** Share a sweep across scheduled and manual callers using the same store. */
export function recoverParkedTokens(
  refundClient: ParkedTokenSource,
  storage: ParkedTokenStorage,
  options: ParkedTokenRecoveryOptions = {},
): Promise<ParkedTokenRecovery> {
  const active = activeSweeps.get(storage);
  if (active) return active;
  const sweep = runSweep(refundClient, storage, options).finally(() => {
    activeSweeps.delete(storage);
  });
  activeSweeps.set(storage, sweep);
  return sweep;
}

/**
 * Recover entries, batching likely sub-fee proofs to share the rounded input fee.
 * The fee estimate is only for batching; neither it nor age warrants deletion.
 * Use the original token when a batch cannot be constructed or fails on fees.
 * A failed swap does not tell us which inputs were spent, so only proof-specific
 * evidence can justify pruning; unknown batch failures are never recursively retried.
 */
async function runSweep(
  refundClient: ParkedTokenSource,
  storage: ParkedTokenStorage,
  options: ParkedTokenRecoveryOptions,
): Promise<ParkedTokenRecovery> {
  const result: ParkedTokenRecovery = {
    attempted: 0,
    succeeded: 0,
    parked: 0,
    remaining: 0,
    recoveredFaceValue: { sat: 0, msat: 0 },
    dropped: [],
    batches: 0,
    batchesRecovered: 0,
  };
  let entries: Inspection[];
  let spender: ParkedTokenSpender;
  try {
    const snapshot = storage.getCachedReceiveTokens();
    result.parked = result.remaining = snapshot.length;
    if (snapshot.length === 0) return result;
    entries = snapshot.map((entry) => inspect(entry, true));
    spender = refundClient.getCashuSpender();
  } catch {
    result.error = "Could not load parked refund tokens for recovery";
    logger.warn(result.error);
    return result;
  }

  const received = new Set<string>();
  const discarded = new Map<string, ParkedDrop>();
  const noIndividualRetry = new Set<Inspection>();
  const unavailableMints = new Set<string>();
  const groups = new Map<string, Inspection[]>();
  for (const entry of entries) {
    if (entry.undecodable) {
      discarded.set(entry.entry.token, { reason: "undecodable", ...metadataFor(entry) });
      continue;
    }
    if (!entry.mint || !entry.proofs?.length) continue;
    // 100 ppk is a heuristic to identify candidates, not a keyset fee lookup.
    if (entry.amount > Math.ceil(entry.proofs.length / 10)) continue;
    const key = groupKey(entry);
    const siblings = groups.get(key);
    if (siblings) siblings.push(entry);
    else groups.set(key, [entry]);
  }

  const recordReceive = (entry: Inspection) => {
    if (received.has(entry.entry.token)) return;
    received.add(entry.entry.token);
    result.succeeded++;
    result.recoveredFaceValue[entry.unit] += entry.amount;
  };

  async function receive(token: string, mint?: string) {
    let message: string | undefined;
    try {
      const outcome = await spender.receiveToken(token, false);
      if (outcome.success) return "success" as const;
      message = outcome.message;
    } catch (error) {
      message = error instanceof Error ? error.message : undefined;
    }
    if (mint && isUnavailable(message)) unavailableMints.add(mint);
    return classifyFailure(message);
  }

  async function confirmSpent(mint: string, candidates: Inspection[]) {
    if (!options.checkSpent) return;
    const proofs = candidates.flatMap((entry) =>
      (entry.proofs ?? []).map(({ id, secret }) => ({ id, secret })),
    );
    if (proofs.length === 0) return;
    try {
      return await options.checkSpent(mint, proofs);
    } catch {
      // Checkstate is optional and can fail independently of the swap.
      return undefined;
    }
  }

  function recordSpent(entry: Inspection) {
    discarded.set(entry.entry.token, { reason: "already-spent", ...metadataFor(entry) });
  }

  async function receiveBatch(group: Inspection[], token: string) {
    result.batches++;
    const outcome = await receive(token, group[0]?.mint);
    if (outcome === "success") {
      result.batchesRecovered++;
      for (const entry of group) recordReceive(entry);
    }
    return outcome;
  }

  for (const group of groups.values()) {
    const mint = group[0]?.mint;
    if (!mint || unavailableMints.has(mint) || group.length < 2) continue;
    const token = merge(group);
    if (!token) continue;
    const outcome = await receiveBatch(group, token);
    if (outcome === "fee" || outcome === "success") continue;

    // Don't fan out individual attempts after a batch failed for an unknown
    // reason or contacted a mint that may be down. Spent inputs are different:
    // ask the mint once, then try the remaining candidates in one batch.
    for (const entry of group) noIndividualRetry.add(entry);
    if (outcome !== "spent") continue;
    const spent = await confirmSpent(mint, group);
    if (!spent?.size) continue;
    const remaining: Inspection[] = [];
    for (const entry of group) {
      const proofs = entry.proofs ?? [];
      if (proofs.length > 0 && proofs.every((proof) => spent.has(proof.secret))) {
        recordSpent(entry);
      } else if (!proofs.some((proof) => spent.has(proof.secret))) {
        remaining.push(entry);
      }
      // Partially spent entries remain untouched; their other proofs are not lost.
    }
    if (remaining.length === group.length) continue; // No input actually ruled out.
    if (remaining.length === 1) {
      noIndividualRetry.delete(remaining[0]!);
    } else if (remaining.length > 1) {
      const retryToken = merge(remaining);
      if (retryToken) await receiveBatch(remaining, retryToken);
    }
  }

  for (const entry of entries) {
    const token = entry.entry.token;
    if (received.has(token) || discarded.has(token) || noIndividualRetry.has(entry)) continue;
    if (entry.mint && unavailableMints.has(entry.mint)) continue;
    result.attempted++;
    const outcome = await receive(token, entry.mint);
    if (outcome === "success") {
      recordReceive(entry);
    } else if (outcome === "spent" && entry.mint) {
      const proofs = entry.proofs;
      if (proofs?.length === 1) {
        // The original swap contained only one proof; no attribution ambiguity.
        recordSpent(entry);
      } else if (proofs?.length) {
        const spent = await confirmSpent(entry.mint, [entry]);
        if (spent && proofs.every((proof) => spent.has(proof.secret))) recordSpent(entry);
      }
    }
  }

  if (received.size || discarded.size) {
    try {
      // Re-read so tokens parked by another operation during mint I/O survive.
      const current = storage.getCachedReceiveTokens();
      result.remaining = current.length;
      const kept = current.filter(({ token }) => !received.has(token) && !discarded.has(token));
      if (kept.length !== current.length) {
        storage.setCachedReceiveTokens(kept);
        await options.flush?.();
      }
      result.remaining = kept.length;
      result.dropped = current.flatMap(({ token }) => {
        const drop = discarded.get(token);
        return drop ? [drop] : [];
      });
    } catch {
      result.pruneError = "Could not persist parked refund token removals";
      logger.warn(result.pruneError);
    }
  }

  if (result.dropped.length) {
    logger.warn(`Discarded ${result.dropped.length} unrecoverable parked refund token(s).`);
  }
  if (result.attempted || result.batches || result.dropped.length) {
    logger.log(
      `Parked refund tokens: ${result.attempted} individual attempts, ${result.batchesRecovered}/${result.batches} batches received, ` +
        `${result.succeeded} entries received, ${result.remaining} remaining, ${result.dropped.length} discarded.`,
    );
  }
  return result;
}

export interface ParkedTokenReport {
  amount: number;
  unit: Unit;
  mint?: string;
  createdAt: number;
  ageDays: number;
  proofCount: number;
  problem?: string;
}

/** Inspect stored metadata without publishing bearer tokens or requesting mint keys. */
export function inspectParkedTokens(
  storage: ParkedTokenStorage,
  options: { now?: number } = {},
): ParkedTokenReport[] {
  const now = options.now ?? Date.now();
  return storage.getCachedReceiveTokens().map((entry) => {
    const inspection = inspect(entry);
    return {
      ...metadataFor(inspection),
      createdAt: entry.createdAt,
      ageDays: Number.isFinite(entry.createdAt)
        ? Math.max(0, Math.floor((now - entry.createdAt) / 86_400_000))
        : 0,
      proofCount: inspection.proofCount,
      ...(inspection.undecodable ? { problem: "Token metadata could not be decoded" } : {}),
    };
  });
}
