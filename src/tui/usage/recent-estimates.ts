import type { PiSession } from "./sessions-data.ts";
import type { UsageTrackingEntry } from "../../daemon/types.ts";
import type { RequestTableEntry } from "./render.ts";

/** Only canonical, eligible transcript comparisons with unique IDs are transferable. */
export function recentEstimateIndex(sessions: PiSession[]): Map<string, number> {
  const counts = new Map<string, number>();
  const values = new Map<string, number>();
  for (const session of sessions) for (const t of session.turns) {
    if (!t.responseId) continue;
    counts.set(t.responseId, (counts.get(t.responseId) ?? 0) + 1);
    if (!session.warnings.length && t.eligible) values.set(t.responseId, t.missed);
  }
  for (const [id, count] of counts) if (count !== 1) values.delete(id);
  return values;
}
export function annotateRecent(entries: UsageTrackingEntry[], estimates: ReadonlyMap<string, number>, local: boolean): RequestTableEntry[] {
  const key = (e: UsageTrackingEntry) => (e as UsageTrackingEntry & { upstreamResponseId?: string }).upstreamResponseId || e.requestId;
  const counts = new Map<string, number>();
  for (const e of entries) { const id = key(e); if (id) counts.set(id, (counts.get(id) ?? 0) + 1); }
  return entries.map(e => {
    const id = key(e);
    const estimatedMissedTokens = local && id && counts.get(id) === 1 ? estimates.get(id) : undefined;
    return { ...e, estimatedMissedTokens };
  });
}
