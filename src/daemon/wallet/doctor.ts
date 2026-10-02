/**
 * Pure selection and classification helpers for `routstrd wallet doctor`.
 *
 * The doctor is a READ-ONLY health check. These helpers decide *what* is
 * worth reporting from operations the wallet already knows about; the live
 * data gathering (trusted mint list, NUT-06 mint probes, NUT-04 quote state
 * reads, inflight proof lookups) is wired up by the in-process coco wallet
 * client. Nothing here - and nothing the client does on behalf of the
 * doctor - may mutate wallet state: no observe-and-persist, no finalize, no
 * fail. Remediation is always left to the operator via the recovery and
 * cleanup commands each finding points to.
 *
 * Keeping the decisions here makes them unit testable without a wallet
 * database or network access.
 */

import {
  classifyMintQuoteObservation,
  type PendingMintCheckCategory,
} from "./mint-quote-recovery";

/** How far back "recent" unpaid quotes reach. */
export const DOCTOR_RECENT_QUOTE_WINDOW_MS = 60 * 60 * 1000;

/** Prepared melts younger than this are considered normal, not stuck. */
export const DOCTOR_STUCK_MELT_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export type DoctorSeverity = "ok" | "warning" | "critical";

/** Subset of coco's mint operation rows the doctor needs. */
export interface DoctorMintOperation {
  id: string;
  mintUrl: string;
  quoteId?: string;
  /** coco state: init | pending | executing | finalized | failed. */
  state: string;
  /** Quote amount in sats. */
  amount: number;
  /** Quote expiry in epoch seconds. `0` means unknown/not applicable. */
  expiry: number;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
  /** Last update time in epoch milliseconds. */
  updatedAt: number;
  /** Last quote state observed from the mint (UNPAID, PAID, ISSUED). */
  lastObservedRemoteState?: string;
  error?: string;
}

/** Subset of coco's melt operation rows the doctor needs. */
export interface DoctorMeltOperation {
  id: string;
  mintUrl: string;
  quoteId?: string;
  /**
   * coco state: init | prepared | executing | pending | failed | finalized |
   * rolling_back | rolled_back.
   */
  state: string;
  /** Invoice amount in sats. */
  amount: number;
  /** Fee reserve locked alongside the amount, in sats. */
  feeReserve: number;
  /** Secrets of the input proofs this operation reserved. */
  inputProofSecrets: string[];
  createdAt: number;
  updatedAt: number;
  error?: string;
}

/** Result of probing one mint's NUT-06 info endpoint. */
export interface DoctorMintProbe {
  mintUrl: string;
  reachable: boolean;
  latencyMs?: number;
  error?: string;
}

/** A pending quote created recently that the mint still reports UNPAID. */
export interface DoctorUnpaidQuote {
  operationId: string;
  quoteId?: string;
  mintUrl: string;
  amount: number;
  ageMs: number;
  /** Milliseconds until the bolt11 quote expires; negative when expired. */
  expiresInMs?: number;
}

/**
 * A quote the mint reports PAID (claimable) or ISSUED (restorable) while the
 * local operation never finalized - the stuck scenario `wallet recover`
 * exists to fix.
 */
export interface DoctorPaidUnissuedQuote {
  operationId: string;
  quoteId?: string;
  mintUrl: string;
  amount: number;
  localState: string;
  remoteState: "PAID" | "ISSUED";
  /**
   * coco's persisted error, when any. A mint rejection such as an inactive
   * keyset means recovery will keep retrying the stored outputs without
   * success until the underlying cause is resolved.
   */
  error?: string;
  /** Suggested remediation command. */
  remediation: string;
}

/** A melt operation holding (or having leaked) locked proofs. */
export interface DoctorStuckMelt {
  operationId: string;
  quoteId?: string;
  mintUrl: string;
  amount: number;
  feeReserve: number;
  ageMs: number;
  /**
   * - `prepared`: proofs reserved, payment never attempted.
   * - `in-flight`: payment may be in flight with the mint.
   * - `failed-locked`: the melt failed but its input proofs were never
   *   released - the worst case, sats are locked locally.
   */
  kind: "prepared" | "in-flight" | "failed-locked";
  /** How many of the operation's input proofs are still locked. */
  lockedSecrets: number;
  error?: string;
  /** Suggested remediation command or explanation. */
  remediation: string;
}

/** Structured result of the doctor's live checks. */
export interface WalletDoctorReport {
  generatedAt: number;
  /** NUT-06 reachability probe per trusted mint. */
  mints: DoctorMintProbe[];
  /** Recent pending quotes the mint still reports UNPAID. */
  unpaidQuotes: DoctorUnpaidQuote[];
  /** Quotes paid/issued at the mint but never finalized locally. */
  paidUnissued: DoctorPaidUnissuedQuote[];
  /** Melt operations holding locked proofs. */
  stuckMelts: DoctorStuckMelt[];
  /** Quotes skipped because the probe budget ran out. */
  uncheckedQuotes: number;
}

/**
 * Map a raw NUT-04 quote state onto coco's pending-check category, so the
 * doctor classifies remote states with the exact same rules as recovery
 * (see classifyMintQuoteObservation in mint-quote-recovery.ts).
 */
export function mintQuoteStateToCategory(
  state: string,
): PendingMintCheckCategory | null {
  switch (state.trim().toUpperCase()) {
    case "UNPAID":
      return "waiting";
    case "PAID":
      return "ready";
    case "ISSUED":
      return "completed";
    default:
      return null;
  }
}

/**
 * Recent pending (or executing) mint quotes worth a fresh UNPAID check.
 *
 * Only quotes created inside `windowMs` are reported: older pending quotes
 * are either expired (cleanup's job) or long-forgotten invoices, and listing
 * them would drown out what the operator actually wants - "did a payment I
 * just started get stuck?". Operations without a quote id cannot be checked
 * with the mint and are skipped.
 */
export function selectRecentMintQuotes<T extends DoctorMintOperation>(
  ops: T[],
  nowMs: number,
  windowMs: number = DOCTOR_RECENT_QUOTE_WINDOW_MS,
): T[] {
  return ops.filter(
    (op) =>
      (op.state === "pending" || op.state === "executing") &&
      typeof op.quoteId === "string" &&
      op.quoteId.length > 0 &&
      nowMs - op.createdAt < windowMs,
  );
}

/**
 * Operations whose remote state could reveal claimable sats.
 *
 * Every pending/executing operation qualifies, matching recovery's candidate
 * rule: only the mint knows whether a quote was paid while the daemon was
 * down. Failed operations qualify only when the last observation recorded
 * PAID/ISSUED - failed quotes last seen UNPAID vastly outnumber recoverable
 * ones, and probing them all would hammer mints for no expected gain. The
 * one exception is a failed operation with *no* recorded observation and a
 * persisted error, which failed without ever learning the remote state.
 */
export function selectPaidUnissuedCandidates<T extends DoctorMintOperation>(
  ops: T[],
): T[] {
  return ops.filter((op) => {
    if (!op.quoteId) return false;
    if (op.state === "pending" || op.state === "executing") return true;
    if (op.state !== "failed") return false;
    return (
      op.lastObservedRemoteState === "PAID" ||
      op.lastObservedRemoteState === "ISSUED" ||
      (op.lastObservedRemoteState === undefined && op.error !== undefined)
    );
  });
}

/**
 * Build a paid-but-not-issued finding from a fresh remote quote state, or
 * return null when the mint's answer means there is nothing to recover.
 */
export function classifyPaidUnissued(
  op: DoctorMintOperation,
  remoteState: string,
): DoctorPaidUnissuedQuote | null {
  const category = mintQuoteStateToCategory(remoteState);
  if (!category) return null;
  const decision = classifyMintQuoteObservation(category);
  if (decision.action !== "finalize") return null;
  const needsReopen = op.state === "failed";
  return {
    operationId: op.id,
    quoteId: op.quoteId,
    mintUrl: op.mintUrl,
    amount: op.amount,
    localState: op.state,
    remoteState: decision.observedRemoteState,
    error: op.error,
    remediation:
      `routstrd wallet recover --op ${op.id}` +
      (needsReopen ? " --include-failed" : ""),
  };
}

/** Build an unpaid-quote finding for a recently created pending quote. */
export function toUnpaidQuote(
  op: DoctorMintOperation,
  nowMs: number,
): DoctorUnpaidQuote {
  return {
    operationId: op.id,
    quoteId: op.quoteId,
    mintUrl: op.mintUrl,
    amount: op.amount,
    ageMs: Math.max(0, nowMs - op.createdAt),
    expiresInMs: op.expiry > 0 ? op.expiry * 1000 - nowMs : undefined,
  };
}

export interface StuckMeltContext {
  nowMs: number;
  /** Prepared melts younger than this are not reported. */
  minAgeMs?: number;
  /**
   * Secrets of proofs currently locked (`inflight` state or reserved via
   * `usedByOperationId`). Used to detect failed melts whose proofs were
   * never released.
   */
  inflightSecrets?: ReadonlySet<string>;
}

/**
 * Classify one melt operation as a stuck-melt finding, or return null when
 * the operation is healthy.
 *
 * - `prepared` operations reserve their input proofs but never attempted a
 *   payment; past `minAgeMs` the reservation is almost certainly abandoned.
 *   `wallet cleanup` cancels them and releases the proofs.
 * - `executing`/`pending` operations may have a payment in flight with the
 *   mint; they are reported at any age because their proofs are locked until
   * the mint answers.
 * - `failed` operations should have released their proofs. When any input
 *   secret is still locked, the rollback never happened and the sats are
 *   stranded locally until melt recovery re-runs.
 */
export function classifyStuckMelt(
  op: DoctorMeltOperation,
  context: StuckMeltContext,
): DoctorStuckMelt | null {
  const { nowMs, minAgeMs = DOCTOR_STUCK_MELT_MIN_AGE_MS } = context;
  const ageMs = Math.max(0, nowMs - op.updatedAt);
  const base = {
    operationId: op.id,
    quoteId: op.quoteId,
    mintUrl: op.mintUrl,
    amount: op.amount,
    feeReserve: op.feeReserve,
    ageMs,
    error: op.error,
  };

  if (op.state === "prepared") {
    if (ageMs < minAgeMs) return null;
    return {
      ...base,
      kind: "prepared",
      lockedSecrets: op.inputProofSecrets.length,
      remediation: "routstrd wallet cleanup",
    };
  }

  if (op.state === "executing" || op.state === "pending") {
    return {
      ...base,
      kind: "in-flight",
      lockedSecrets: op.inputProofSecrets.length,
      remediation:
        "payment may be in flight; inspect with routstrd history --json",
    };
  }

  if (op.state === "failed") {
    const locked = context.inflightSecrets
      ? op.inputProofSecrets.filter((secret) =>
          context.inflightSecrets!.has(secret),
        )
      : [];
    if (locked.length === 0) return null;
    return {
      ...base,
      kind: "failed-locked",
      lockedSecrets: locked.length,
      remediation:
        "restart the daemon to re-run melt recovery; if proofs stay locked, report this operation id",
    };
  }

  return null;
}

/**
 * Overall severity of a doctor report, which drives the CLI exit code.
 *
 * Critical means money is provably at risk or a mint cannot be reached at
 * all; warning means something deserves attention but no sats are stranded.
 */
export function doctorReportSeverity(
  report: WalletDoctorReport,
): DoctorSeverity {
  if (report.mints.some((probe) => !probe.reachable)) return "critical";
  if (report.paidUnissued.length > 0) return "critical";
  if (report.stuckMelts.some((melt) => melt.kind === "failed-locked")) {
    return "critical";
  }
  if (
    report.unpaidQuotes.length > 0 ||
    report.stuckMelts.length > 0 ||
    report.uncheckedQuotes > 0
  ) {
    return "warning";
  }
  return "ok";
}
