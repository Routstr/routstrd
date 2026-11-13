/**
 * Recovery of refund tokens the SDK parked after a failed receive.
 *
 * When a provider refund returns a Cashu token and the swap fails (typically
 * "Failed to fetch mint" while the mint is unreachable), `CashuSpender`
 * `cacheReceiveToken`s it and keeps it in `cachedReceiveTokens`. Those tokens
 * are already paid for, so they are money the wallet holds but has not
 * redeemed.
 *
 * Every refund entry point runs through this helper so the scheduled job and
 * both manual routes recover the same set — the parked list is not part of the
 * store's `cachedTokens`/`apiKeys` buckets, so a caller that only looks at
 * those will happily report "nothing to refund" while funds sit unredeemed.
 *
 * ## Why this does not just call `CashuSpender.recoverCachedReceiveTokens()`
 *
 * That sweep retries each parked token as its own receive and only drops an
 * entry when the receive succeeds or its message matches /already spent/. Two
 * kinds of token therefore never leave the list, and can never succeed:
 *
 *   1. Dust on a fee-charging mint. A 1-sat single-proof token on a 100 ppk
 *      mint pays a 1-sat input fee, so coco-core rejects it in `prepare()` with
 *      "Receive amount is not sufficient after fees" — locally, before the mint
 *      is ever asked. The entry is retried forever: 59 tokens x 34 cycles/day
 *      produced ~2,000 ERROR lines/day with zero recoveries.
 *   2. Anything the mint has already spent whose error message does not happen
 *      to contain "already spent".
 *
 * Both are terminal. So this module drives the retry itself — `receiveToken`
 * returns the failure message that the SDK sweep throws away — classifies it,
 * and drops what can never be received.
 *
 * Before giving up on sub-fee dust it merges same-mint tokens into one token:
 * a receive pays the mint's input fee per proof, so N one-proof tokens cost N
 * separate fees while one merged token pays a single fee. 59 x 1 sat at 100 ppk
 * is 59 sat of fees alone (every token dies on a 1-sat fee) but 6 sat merged,
 * recovering 53 sat. A merged receive is also what finally asks the mint about
 * dust, so the mint — not a local guard — decides whether proofs are spent.
 *
 * The classification, merging and pruning decisions are pure functions so they
 * can be tested without a mint, a wallet or a database.
 */
import { getDecodedToken, getEncodedToken } from "@cashu/cashu-ts";
import { logger } from "../../utils/logger";

/** Structural subset of `CashuSpender` needed here (keeps tests trivial). */
export interface ParkedTokenSpender {
  /**
   * Receive one token, returning the failure message instead of throwing.
   * `cacheOnFailure=false` because this module owns the parked list; letting
   * the SDK re-cache mid-sweep would fight the prune at the end of the run.
   */
  receiveToken(
    token: string,
    cacheOnFailure?: boolean,
  ): Promise<{
    success: boolean;
    amount: number;
    unit: "sat" | "msat";
    message?: string;
  }>;
}

/** Structural subset of the SDK client needed here. */
export interface ParkedTokenSource {
  getCashuSpender(): ParkedTokenSpender;
}

/** One parked entry as the SDK store holds it. */
export interface ParkedTokenEntry {
  token: string;
  amount: number;
  unit: "sat" | "msat";
  createdAt: number;
}

/** Structural subset of the SDK storage adapter needed here. */
export interface ParkedTokenStorage {
  getCachedReceiveTokens(): ParkedTokenEntry[];
  setCachedReceiveTokens(tokens: ParkedTokenEntry[]): void;
}

/** Why a parked token was dropped instead of retried. */
export type ParkedDropReason =
  /** Token does not decode; nothing can ever be received from it. */
  | "undecodable"
  /** The mint reports the proofs spent (or coco says so). Value is gone. */
  | "already-spent"
  /** Value is fully consumed by the mint's input fee, even merged. */
  | "fee-exceeds-value"
  /** Older than the retention window; no longer worth retrying. */
  | "expired";

/** One dropped entry, for reporting. */
export interface ParkedDrop {
  token: string;
  reason: ParkedDropReason;
  amount: number;
  mint?: string;
  detail?: string;
}

/** Proofs are normalised to plain numbers so every later sum is arithmetic. */
export interface ParkedProof {
  amount: number;
  id: string;
  secret: string;
  C: string;
}

/** One parked entry plus what could be worked out about it. */
export interface ParkedTokenInspection {
  entry: ParkedTokenEntry;
  /** Mint the token belongs to, when it decoded. */
  mint?: string;
  unit: "sat" | "msat";
  /** Proofs in the token; what the mint sees as inputs. */
  proofs: ParkedProof[];
  /** Why this entry cannot be read at all, when it cannot. */
  error?: string;
}

/** Outcome of one `recoverParkedTokens` run. */
export interface ParkedTokenRecovery {
  /** Tokens retried individually this run. */
  attempted: number;
  /** Of those, how many were received. */
  succeeded: number;
  /** Parked entries present at the start of the run. */
  parked: number;
  /** Value received this run, in sat. */
  recoveredAmount: number;
  /** Entries dropped because they can never be received. */
  dropped: ParkedDrop[];
  /** Merged receives attempted after individual retries. */
  batches: number;
  /** Merged receives that succeeded. */
  batchesRecovered: number;
  /** Set when the sweep itself failed; tokens stay parked. */
  error?: string;
}

/**
 * Default retention window for parked tokens.
 *
 * A refunded token is redeemable indefinitely, but one that has survived this
 * long is either already spent or dust that cannot be swapped. Keeping it
 * parked forever only produces log noise, so it is reported and dropped.
 */
export const PARKED_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Failures that mean retrying this token can never succeed.
 *
 * Deliberately narrow: an unrecognised failure is transient, so a flaky mint
 * or a wallet hiccup never destroys a redeemable token.
 */
const TERMINAL_MESSAGE_PATTERNS: Array<{
  pattern: RegExp;
  reason: ParkedDropReason;
}> = [
  // coco-core rejects sub-fee receives in prepare(), before contacting the
  // mint. Per-token retries can never satisfy it; only merging can, which is
  // why the caller tries a batched receive before acting on this.
  { pattern: /not sufficient after fees/i, reason: "fee-exceeds-value" },
  // The mint's own wording for a receive whose fee consumes the whole value:
  // it is asked to mint zero outputs, and rejects the request.
  { pattern: /no outputs provided/i, reason: "fee-exceeds-value" },
  // The mint's authority: these proofs are gone whoever holds the token.
  { pattern: /already spent/i, reason: "already-spent" },
  { pattern: /keyset .*(unknown|not found)/i, reason: "already-spent" },
  // Not a Cashu token that can ever be received.
  { pattern: /invalid token/i, reason: "undecodable" },
  { pattern: /could not decode/i, reason: "undecodable" },
  { pattern: /malformed/i, reason: "undecodable" },
];

/**
 * Classify a receive failure.
 *
 * Returns the terminal reason, or `undefined` when the failure may be
 * transient and the token is worth keeping.
 */
export function classifyParkedFailure(
  message: string | undefined,
): ParkedDropReason | undefined {
  if (!message) return undefined;
  for (const { pattern, reason } of TERMINAL_MESSAGE_PATTERNS) {
    if (pattern.test(message)) return reason;
  }
  return undefined;
}

/**
 * Decode one parked entry into the proofs a receive would present.
 *
 * `getDecodedToken` needs the mint's keyset ids; an empty list is enough to
 * read amounts, secrets and ids, which is all a merge needs. A token that does
 * not decode is reported rather than thrown, so one bad entry cannot abort the
 * sweep over the rest.
 */
export function inspectParkedToken(entry: ParkedTokenEntry): ParkedTokenInspection {
  const unit = entry.unit === "msat" ? "msat" : "sat";
  try {
    const decoded = getDecodedToken(entry.token, []);
    return {
      entry,
      mint: decoded.mint,
      unit: (decoded.unit as "sat" | "msat") ?? unit,
      // cashu-ts hands back Amount objects; coerce once here so callers can
      // treat proof.amount as a plain number.
      proofs: decoded.proofs.map((proof) => ({
        amount: Number(proof.amount),
        id: proof.id,
        secret: proof.secret,
        C: proof.C,
      })),
    };
  } catch (error) {
    return {
      entry,
      unit,
      proofs: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Whether a token is too small to be received on its own.
 *
 * coco-core computes `amount - fee(proofs)` and refuses anything that does not
 * stay positive, so a token whose value does not exceed its own input fee can
 * never be received alone. Those are the only tokens worth merging: batching a
 * token that could succeed by itself would put it at risk of the batch's
 * all-or-nothing rejection for no gain.
 *
 * The fee is 1 sat per started 1000 ppk of total input weight, which is the
 * NUT-02 rule for a 100 ppk mint. The exact per-keyset rate lives in the
 * wallet database, so this deliberately errs towards merging: a token that is
 * wrongly batched is still recovered by bisection.
 */
export function isSubFeeDust(inspection: ParkedTokenInspection): boolean {
  const amount = inspection.proofs.reduce((sum, proof) => sum + proof.amount, 0);
  const fee = Math.ceil((SUB_FEE_PPK_ASSUMPTION * inspection.proofs.length) / 1000);
  return amount - fee <= 0;
}

/**
 * Input fee assumed when judging whether a single token can be received alone.
 *
 * 100 ppk is what the mints in play charge (cubabitcoin and minibits both
 * advertise it for sat); the assumption only decides whether a token is
 * batched, and bisection rescues anything judged wrongly.
 */
const SUB_FEE_PPK_ASSUMPTION = 100;

/** Tokens sharing one mint+unit, which can be received as a single token. */
export interface ParkedMergeGroup {
  mint: string;
  unit: "sat" | "msat";
  entries: ParkedTokenInspection[];
}

/**
 * Group inspectable tokens by mint and unit.
 *
 * Only groups of more than one are returned: a single token is exactly what
 * the individual retry already attempted, so merging it changes nothing.
 */
export function groupForMerge(
  inspections: ParkedTokenInspection[],
): ParkedMergeGroup[] {
  const groups = new Map<string, ParkedMergeGroup>();
  for (const inspection of inspections) {
    if (inspection.error || !inspection.mint || inspection.proofs.length === 0) {
      continue;
    }
    const key = `${inspection.mint}\u0000${inspection.unit}`;
    const existing = groups.get(key);
    if (existing) existing.entries.push(inspection);
    else
      groups.set(key, {
        mint: inspection.mint,
        unit: inspection.unit,
        entries: [inspection],
      });
  }
  return [...groups.values()].filter((group) => group.entries.length > 1);
}

/**
 * Merge entries from one mint into a single token.
 *
 * The receive pays the mint's input fee per proof, so merging N one-proof
 * tokens turns N fee payments into one.
 */
export function mergeInspections(
  entries: ParkedTokenInspection[],
): { token: string; proofCount: number; amount: number } {
  const first = entries[0];
  if (!first?.mint) throw new Error("cannot merge entries without a mint");
  const proofs: ParkedProof[] = [];
  for (const entry of entries) proofs.push(...entry.proofs);
  const token = getEncodedToken({
    mint: first.mint,
    unit: first.unit,
    proofs,
  } as never);
  const amount = proofs.reduce((sum, proof) => sum + proof.amount, 0);
  return { token, proofCount: proofs.length, amount };
}

/**
 * Decide which parked entries to drop.
 *
 * Precedence: a token that was received is gone and needs no decision; an
 * unreadable token is dropped without a mint round-trip; a terminal verdict is
 * honoured; otherwise age decides. Everything else stays parked.
 *
 * `fee-exceeds-value` is only considered terminal when `merged` is true,
 * because merging is the one thing that can still rescue sub-fee dust.
 */
export function planParkedDrops(
  inspections: ParkedTokenInspection[],
  outcome: {
    /** Tokens received this run; already removed from the list. */
    received: Set<string>;
    /** Token -> terminal reason observed this run. */
    terminal: Map<string, { reason: ParkedDropReason; detail?: string }>;
    /** Whether a merged receive was attempted for this run. */
    merged: boolean;
    now: number;
    maxAgeMs?: number;
  },
): ParkedDrop[] {
  const maxAgeMs = outcome.maxAgeMs ?? PARKED_TOKEN_MAX_AGE_MS;
  const drops: ParkedDrop[] = [];
  for (const inspection of inspections) {
    const { entry } = inspection;
    if (outcome.received.has(entry.token)) continue;

    const drop = (reason: ParkedDropReason, detail?: string) =>
      drops.push({
        token: entry.token,
        reason,
        amount: entry.amount,
        ...(inspection.mint ? { mint: inspection.mint } : {}),
        ...(detail ? { detail } : {}),
      });

    if (inspection.error) {
      drop("undecodable", inspection.error);
      continue;
    }

    const terminal = outcome.terminal.get(entry.token);
    if (terminal) {
      // Sub-fee dust is only hopeless once a merged receive was tried.
      if (terminal.reason !== "fee-exceeds-value" || outcome.merged) {
        drop(terminal.reason, terminal.detail);
        continue;
      }
    }

    // Age alone only condemns dust. A token worth more than its own fee can be
    // received whenever the mint is reachable, so dropping it on age would
    // destroy redeemable money during a mint outage — the very moment a sweep
    // is most likely to fail. Non-dust tokens stay parked until the mint rules
    // on them.
    const age = outcome.now - entry.createdAt;
    if (Number.isFinite(age) && age > maxAgeMs && isSubFeeDust(inspection)) {
      drop("expired", `parked ${Math.floor(age / 86_400_000)} day(s) ago`);
    }
  }
  return drops;
}

/**
 * Retry every parked refund token, merge what is left where possible, and
 * discard the entries that can never be received.
 *
 * Never throws: a broken mint (or any unexpected SDK error) must not abort the
 * refund that follows it, because the parked tokens stay parked and the next
 * call retries them again.
 */
export async function recoverParkedTokens(
  refundClient: ParkedTokenSource,
  storage?: ParkedTokenStorage,
  options: { now?: number; maxAgeMs?: number } = {},
): Promise<ParkedTokenRecovery> {
  const now = options.now ?? Date.now();

  let parkedEntries: ParkedTokenEntry[];
  try {
    parkedEntries = storage?.getCachedReceiveTokens() ?? [];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not read parked refund tokens: ${detail}`);
    return emptyRecovery(0, detail);
  }

  if (parkedEntries.length === 0) return emptyRecovery(0);

  if (!storage) {
    logger.warn(
      "Parked refund tokens cannot be recovered without a storage adapter.",
    );
    return emptyRecovery(parkedEntries.length);
  }

  const spender = refundClient.getCashuSpender();
  const inspections = parkedEntries.map(inspectParkedToken);
  const received = new Set<string>();
  const terminal = new Map<
    string,
    { reason: ParkedDropReason; detail?: string }
  >();
  let attempted = 0;
  let recoveredAmount = 0;

  // ── Pass 1: merge same-mint dust first ───────────────────────
  // Sub-fee dust can only ever be received in a batch, and a batch is also the
  // only way the mint itself gets to rule on those proofs: coco-core rejects a
  // single 1-sat token locally, before the mint is asked, so a per-token retry
  // reports "not sufficient after fees" even when the mint would have said the
  // proofs are spent. Batching first means the verdict we report is the mint's.
  let batches = 0;
  let batchesRecovered = 0;
  const inspectionsForMerge = inspections.filter(
    (inspection) => !inspection.error && isSubFeeDust(inspection),
  );
  for (const group of groupForMerge(inspectionsForMerge)) {
    const verdict = await receiveMergedGroup(spender, group, received);
    batches += 1;
    if (verdict.recoveredAmount > 0) {
      batchesRecovered += 1;
      recoveredAmount += verdict.recoveredAmount;
      logger.log(
        `Recovered ${verdict.recoveredAmount} sat by merging ${verdict.recoveredCount} parked token(s) from ${group.mint}.`,
      );
    }
    for (const [token, entry] of verdict.terminal) {
      terminal.set(token, entry);
    }
  }

  // ── Pass 2: retry whatever is still token-sized ──────────────
  // Anything a batch could not receive (a single token on its own mint, or one
  // the mint has not been asked about yet) gets its own attempt, which is where
  // a token that only needed the mint to be reachable gets redeemed.
  for (const inspection of inspections) {
    if (inspection.error) continue;
    if (received.has(inspection.entry.token)) continue;
    // A batch already recorded the mint's verdict for this token.
    if (terminal.has(inspection.entry.token)) continue;
    attempted += 1;
    try {
      const outcome = await spender.receiveToken(inspection.entry.token, false);
      if (outcome.success) {
        received.add(inspection.entry.token);
        recoveredAmount += outcome.amount;
        continue;
      }
      const reason = classifyParkedFailure(outcome.message);
      if (reason) {
        terminal.set(inspection.entry.token, {
          reason,
          detail: outcome.message,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = classifyParkedFailure(message);
      if (reason) {
        terminal.set(inspection.entry.token, { reason, detail: message });
      }
    }
  }

  const drops = planParkedDrops(inspections, {
    received,
    terminal,
    merged: batches > 0,
    now,
    maxAgeMs: options.maxAgeMs,
  });
  const droppedTokens = new Set(drops.map((drop) => drop.token));

  // ── Pass 3: rewrite the parked list once ─────────────────────
  if (received.size > 0 || droppedTokens.size > 0) {
    try {
      storage.setCachedReceiveTokens(
        storage
          .getCachedReceiveTokens()
          .filter(
            (entry) =>
              !received.has(entry.token) && !droppedTokens.has(entry.token),
          ),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`Could not prune parked refund tokens: ${detail}`);
    }
  }

  const stillParked = inspections.length - received.size - droppedTokens.size;

  if (drops.length > 0) {
    const droppedAmount = drops.reduce((sum, drop) => sum + drop.amount, 0);
    const byReason = new Map<ParkedDropReason, number>();
    for (const drop of drops) {
      byReason.set(drop.reason, (byReason.get(drop.reason) ?? 0) + 1);
    }
    const summary = [...byReason]
      .map(([reason, count]) => `${count} ${reason}`)
      .join(", ");
    logger.warn(
      `Discarded ${drops.length} unrecoverable parked refund token(s) (${droppedAmount} sat): ${summary}.`,
    );
  }

  if (attempted > 0 || batches > 0 || drops.length > 0) {
    logger.log(
      `Retried ${attempted} parked refund token(s): ${received.size} received` +
        (batches > 0
          ? `, ${batchesRecovered}/${batches} merged batch(es) recovered`
          : "") +
        `, ${stillParked} still parked, ${drops.length} discarded.`,
    );
  }

  return {
    attempted,
    succeeded: received.size,
    parked: inspections.length,
    recoveredAmount,
    dropped: drops,
    batches,
    batchesRecovered,
  };
}

function emptyRecovery(parked: number, error?: string): ParkedTokenRecovery {
  return {
    attempted: 0,
    succeeded: 0,
    parked,
    recoveredAmount: 0,
    dropped: [],
    batches: 0,
    batchesRecovered: 0,
    ...(error ? { error } : {}),
  };
}

/** One parked entry as reported by `inspectParkedTokens`. */
export interface ParkedTokenReport {
  token: string;
  amount: number;
  unit: "sat" | "msat";
  mint?: string;
  createdAt: number;
  /** Age in days, for operators deciding whether to wait or prune. */
  ageDays: number;
  proofCount: number;
  /** Why this entry can never be received, when that is knowable offline. */
  problem?: string;
}

/**
 * Describe the parked list without touching any mint or changing any state.
 *
 * Backs `rout wallet parked`, which exists so an operator can see what is
 * parked and why it is stuck before running a refund — the alternative is
 * reading a SQLite blob or grepping for repeated ERROR lines.
 */
export function inspectParkedTokens(
  storage: ParkedTokenStorage,
  options: { now?: number } = {},
): ParkedTokenReport[] {
  const now = options.now ?? Date.now();
  return storage.getCachedReceiveTokens().map((entry) => {
    const inspection = inspectParkedToken(entry);
    const ageDays = Number.isFinite(entry.createdAt)
      ? Math.max(0, Math.floor((now - entry.createdAt) / 86_400_000))
      : 0;
    return {
      token: entry.token,
      amount: entry.amount,
      unit: entry.unit,
      ...(inspection.mint ? { mint: inspection.mint } : {}),
      createdAt: entry.createdAt,
      ageDays,
      proofCount: inspection.proofs.length,
      ...(inspection.error ? { problem: inspection.error } : {}),
    };
  });
}

/** How many bisection steps a failing merged receive is worth. */
const MAX_MERGE_SPLITS = 6;

/** Result of trying to receive one mint's dust as a merged token. */
interface MergeVerdict {
  recoveredAmount: number;
  recoveredCount: number;
  terminal: Map<string, { reason: ParkedDropReason; detail?: string }>;
}

/**
 * Receive one mint's dust as a single merged token, bisecting on rejection.
 *
 * A merged swap is all-or-nothing, so a batch containing one dead proof makes
 * every good proof in it look dead too. Blaming the whole batch would discard
 * redeemable money, so a rejected batch is split in half and retried until the
 * offending token is isolated (`MAX_MERGE_SPLITS` bounds the work at ~2^6
 * receives per mint). A token only gets a terminal verdict once it fails on
 * its own — anything smaller than a single token is never reported.
 *
 * A sub-fee failure on a single token is not recorded here: it is the same
 * answer pass 1 already got, and `planParkedDrops` needs to know whether a
 * *merged* attempt was made before treating sub-fee dust as hopeless.
 */
async function receiveMergedGroup(
  spender: ParkedTokenSpender,
  group: ParkedMergeGroup,
  received: Set<string>,
): Promise<MergeVerdict> {
  const verdict: MergeVerdict = {
    recoveredAmount: 0,
    recoveredCount: 0,
    terminal: new Map(),
  };

  // The strongest verdict any batch produced for this group. A singleton that
  // only ever reaches coco's local fee guard inherits it: once the mint has
  // said "these proofs are spent", a smaller retry cannot un-say that.
  let groupVerdict: { reason: ParkedDropReason; detail?: string } | undefined;

  const tryReceive = async (entries: ParkedTokenInspection[]): Promise<boolean> => {
    let merged: ReturnType<typeof mergeInspections>;
    try {
      merged = mergeInspections(entries);
    } catch {
      // Merging needs a shared mint; a group always has one, so this is a
      // decode problem, and those entries are handled by planParkedDrops.
      return true;
    }
    try {
      const outcome = await spender.receiveToken(merged.token, false);
      if (outcome.success) {
        verdict.recoveredAmount += merged.amount;
        verdict.recoveredCount += entries.length;
        for (const entry of entries) received.add(entry.entry.token);
        return true;
      }
      const reason = classifyParkedFailure(outcome.message);
      if (reason && reason !== "fee-exceeds-value") {
        groupVerdict ??= { reason, detail: outcome.message };
      }
      // A multi-token rejection cannot be blamed on one token, so only a
      // single-token failure is attributed to the token itself.
      const only = entries[0];
      if (reason && only && entries.length === 1 && reason !== "fee-exceeds-value") {
        verdict.terminal.set(only.entry.token, { reason, detail: outcome.message });
      }
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = classifyParkedFailure(message);
      if (reason && reason !== "fee-exceeds-value") {
        groupVerdict ??= { reason, detail: message };
      }
      const only = entries[0];
      if (reason && only && entries.length === 1 && reason !== "fee-exceeds-value") {
        verdict.terminal.set(only.entry.token, { reason, detail: message });
      }
      return false;
    }
  };

  const bisect = async (entries: ParkedTokenInspection[], depth: number): Promise<void> => {
    const settled = await tryReceive(entries);
    if (settled !== false) return;

    // One token that cannot be received on its own: nothing left to isolate.
    if (entries.length === 1) return;
    if (depth >= MAX_MERGE_SPLITS) {
      logger.warn(
        `Gave up isolating ${entries.length} parked token(s) from ${group.mint} after ${MAX_MERGE_SPLITS} splits; leaving them parked.`,
      );
      return;
    }

    const middle = Math.ceil(entries.length / 2);
    await bisect(entries.slice(0, middle), depth + 1);
    await bisect(entries.slice(middle), depth + 1);
  };

  await bisect(group.entries, 0);

  // A batch rejected as "already spent" only proves that *at least one* proof
  // in it is spent, so handing that verdict to every member would discard
  // redeemable money. It is only safe when no member could ever be received
  // alone: then the group yields nothing however the blame is distributed, and
  // leaving it parked would just retry uncollectable dust forever.
  const allUncollectable = group.entries.every((entry) => isSubFeeDust(entry));
  if (groupVerdict && allUncollectable) {
    for (const entry of group.entries) {
      if (received.has(entry.entry.token)) continue;
      if (verdict.terminal.has(entry.entry.token)) continue;
      verdict.terminal.set(entry.entry.token, groupVerdict);
    }
  }
  return verdict;
}
