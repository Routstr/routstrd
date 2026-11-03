/**
 * Melt history state annotation.
 *
 * coco records a melt history row's `state` from the Lightning quote only:
 * `UNPAID` means the invoice was never paid, which is exactly what a
 * rolled-back melt is too. That makes a finished melt read identically to one
 * that is still waiting. The operation row distinguishes them, so expose its
 * state as `operationState` and let the CLI render the difference.
 */
import type { HistoryEntry } from "@cashu/coco-core";

/** Minimal melt-operation source needed to state-annotate history rows. */
export interface MeltHistoryStateSource {
  ops: {
    melt: { get(operationId: string): Promise<{ state: string } | null> };
  };
}

/** A melt history entry carrying the operation's own state for the CLI. */
export type MeltHistoryEntryWithOperationState = Extract<
  HistoryEntry,
  { type: "melt" }
> & { operationState?: string };

/**
 * Attach the melt operation's own state to history entries.
 *
 * Read-only: a history row that outlives its operation is left untouched, and
 * non-melt entries pass through unchanged.
 */
export async function attachMeltOperationStates(
  source: MeltHistoryStateSource,
  entries: HistoryEntry[],
): Promise<HistoryEntry[]> {
  const operationIds = [
    ...new Set(
      entries
        .filter((entry) => entry.type === "melt" && entry.operationId)
        .map((entry) => entry.operationId as string),
    ),
  ];
  if (operationIds.length === 0) return entries;

  const states = new Map<string, string>();
  await Promise.all(
    operationIds.map(async (operationId) => {
      try {
        const operation = await source.ops.melt.get(operationId);
        if (operation) states.set(operationId, operation.state);
      } catch {
        // The history row can outlive its operation; keep the stored state.
      }
    }),
  );
  if (states.size === 0) return entries;

  return entries.map((entry) => {
    if (entry.type !== "melt" || !entry.operationId) return entry;
    const operationState = states.get(entry.operationId);
    if (!operationState) return entry;
    return {
      ...entry,
      operationState,
    } satisfies MeltHistoryEntryWithOperationState;
  });
}
