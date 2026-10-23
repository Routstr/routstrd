/** Transaction types understood by the wallet history type filter. */
export const HISTORY_ENTRY_TYPES = ["mint", "melt", "send", "receive"] as const;

export type HistoryEntryType = (typeof HISTORY_ENTRY_TYPES)[number];

/** True when `value` is a recognized history transaction type. */
export function isHistoryEntryType(value: string): value is HistoryEntryType {
  return (HISTORY_ENTRY_TYPES as readonly string[]).includes(value);
}

// Finished entries map to "" so only the unusual rows carry a label.
const HISTORY_STATUS: Record<string, string> = {
  finalized: "",
  ISSUED: "",
  PAID: "",
  prepared: "waiting",
  pending: "waiting",
  UNPAID: "waiting",
  PENDING: "waiting",
  rolledBack: "cancelled",
};

/**
 * Map a stored history state to the label shown by `routstrd history`.
 *
 * A melt history row only tracks the Lightning quote (UNPAID/PENDING/PAID), so
 * a rolled-back melt is stored as `UNPAID` — the invoice was never paid. That
 * is indistinguishable from a melt that is still waiting unless the caller
 * also passes the operation's own state. When that state says the operation is
 * finished, prefer it so a rolled-back melt reads as cancelled, not waiting.
 */
export function historyStatus(
  type: string,
  state: string,
  operationState?: string,
): string {
  // A PAID mint quote means paid but not minted yet, the case `wallet recover` handles.
  if (type === "mint" && state === "PAID") return "paid, not minted";
  if (type === "melt" && operationState) {
    if (operationState === "rolled_back" || operationState === "rolling_back") {
      return "cancelled";
    }
    if (operationState === "finalized") return "";
  }
  return HISTORY_STATUS[state] ?? state;
}
