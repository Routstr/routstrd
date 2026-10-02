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

export function historyStatus(type: string, state: string): string {
  // A PAID mint quote means paid but not minted yet, the case `wallet recover` handles.
  if (type === "mint" && state === "PAID") return "paid, not minted";
  return HISTORY_STATUS[state] ?? state;
}
