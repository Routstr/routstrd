/**
 * Pure selection and summarisation helpers for the wallet proof-state check.
 *
 * `rout wallet check-proofs` asks every mint that holds our ready or inflight
 * proofs what it thinks of them (NUT-07 checkstate) and marks the ones the
 * mint reports SPENT as spent locally, so their balance is reclaimed instead
 * of silently inflating the wallet. All network work lives in `coco-client`;
 * the decisions live here so they can be unit tested without a mint or a
 * wallet database — the same split as `cleanup.ts`.
 *
 * Why both `ready` and `inflight`:
 *   - a `ready` proof can already be spent by another wallet holding the same
 *     secret (a restored, duplicated, or double-issued token), and
 *   - an `inflight` proof may have been spent by the operation that reserved
 *     it before that operation was interrupted.
 * In both cases the mint is the authority, and local state that disagrees with
 * it is unrecoverable value still counted in the balance.
 */
import type { CoreProof } from "@cashu/coco-core";

/** Mints commonly cap how many Ys a single checkstate call accepts. */
export const PROOF_CHECK_BATCH_SIZE = 100;

/** Proofs sharing one mint, which must be checked together. */
export interface ProofCheckGroup {
  mintUrl: string;
  proofs: CoreProof[];
}

/**
 * Group proofs by mint, preserving first-seen mint order.
 *
 * Proofs with no mint URL are dropped: the mint is who we ask, so a proof we
 * cannot attribute to one can neither be checked nor reported.
 */
export function groupProofsByMint(proofs: CoreProof[]): ProofCheckGroup[] {
  const byMint = new Map<string, CoreProof[]>();
  for (const proof of proofs) {
    const mintUrl = proof.mintUrl;
    if (!mintUrl) continue;
    const bucket = byMint.get(mintUrl);
    if (bucket) bucket.push(proof);
    else byMint.set(mintUrl, [proof]);
  }
  return [...byMint].map(([mintUrl, grouped]) => ({ mintUrl, proofs: grouped }));
}

/** Split items into batches of at most `size`, preserving order. */
export function chunk<T>(items: T[], size: number = PROOF_CHECK_BATCH_SIZE): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`batch size must be a positive integer, got ${size}`);
  }
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/** A proof paired with the state the mint reported for it. */
export interface CheckedProof {
  proof: CoreProof;
  /** NUT-07 state as reported by the mint: UNSPENT, PENDING or SPENT. */
  state: string;
}

/**
 * Pair each proof with the state the mint reported for it.
 *
 * Returns `null` when the mint's answer cannot be trusted. A short or long
 * response would shift every later state onto the wrong proof, and a missing
 * state is just as unusable. Callers must treat `null` as "the mint did not
 * answer" and never as "unspent" — guessing here keeps value the mint has
 * already burned, and marking on a shifted response spends the wrong proofs.
 */
export function pairProofStates(
  proofs: CoreProof[],
  states: Array<{ state?: string } | undefined>,
): CheckedProof[] | null {
  if (states.length !== proofs.length) return null;
  const paired: CheckedProof[] = [];
  for (let i = 0; i < proofs.length; i++) {
    const proof = proofs[i];
    const state = states[i]?.state;
    if (!proof || typeof state !== "string") return null;
    paired.push({ proof, state });
  }
  return paired;
}

/**
 * Split checked proofs into the three outcomes the command reports.
 *
 * `unresolved` covers PENDING (the mint is mid-spend) and any state we do not
 * recognise: neither is safe to mark, so they are left for the mint to settle.
 */
export function partitionCheckedProofs(checked: CheckedProof[]): {
  spent: CheckedProof[];
  unspent: CheckedProof[];
  unresolved: CheckedProof[];
} {
  const spent: CheckedProof[] = [];
  const unspent: CheckedProof[] = [];
  const unresolved: CheckedProof[] = [];
  for (const entry of checked) {
    if (entry.state === "SPENT") spent.push(entry);
    else if (entry.state === "UNSPENT") unspent.push(entry);
    else unresolved.push(entry);
  }
  return { spent, unspent, unresolved };
}

/** Total value of a set of proofs, in sat. */
export function totalAmount(proofs: CoreProof[]): number {
  return proofs.reduce((sum, proof) => sum + (proof.amount ?? 0), 0);
}
