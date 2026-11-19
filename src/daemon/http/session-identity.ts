import type { UsageTrackingDriver } from "@routstr/sdk";

const SESSION_HEADERS = [
  "x-session-id", "session-id", "session_id", "x-session-affinity", "x-opencode-session",
];
const SESSION_FIELDS = ["session_id", "sessionId", "prompt_cache_key"];

/** Read a label for local accounting without changing what the caller sent. */
export function readSessionIdentity(headers: Readonly<Record<string, string>>, body: Readonly<Record<string, unknown>>): string | undefined {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const candidates: unknown[] = SESSION_HEADERS.map(key => normalized.get(key));
  candidates.push(...SESSION_FIELDS.map(key => body[key]));
  const metadata = body.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const fields = metadata as Record<string, unknown>;
    candidates.push(fields.session_id, fields.sessionId);
  }
  // Bound the value persisted in accounting, not the caller's request.
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value));
}

/** Bind only this request's append calls; delegate query/maintenance APIs unchanged. */
export function withSessionIdentity(driver: UsageTrackingDriver | undefined, sessionId: string | undefined): UsageTrackingDriver | undefined {
  if (!driver || !sessionId) return driver;
  return {
    migrate: () => driver.migrate(),
    append: entry => driver.append({ ...entry, sessionId }),
    appendMany: entries => driver.appendMany(entries.map(entry => ({ ...entry, sessionId }))),
    list: options => driver.list(options),
    count: options => driver.count(options),
    aggregate: options => driver.aggregate(options),
    deleteOlderThan: timestamp => driver.deleteOlderThan(timestamp),
    clear: () => driver.clear(),
  };
}
