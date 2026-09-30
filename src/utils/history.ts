/** Transaction types understood by the wallet history type filter. */
export const HISTORY_ENTRY_TYPES = ["mint", "melt", "send", "receive"] as const;

export type HistoryEntryType = (typeof HISTORY_ENTRY_TYPES)[number];

/** True when `value` is a recognized history transaction type. */
export function isHistoryEntryType(value: string): value is HistoryEntryType {
  return (HISTORY_ENTRY_TYPES as readonly string[]).includes(value);
}
