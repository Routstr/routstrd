import type { UsageTrackingDriver } from "@routstr/sdk";

// Local correlation only: never expose conversation identity to inference nodes.
const SESSION_HEADERS = [
  "x-session-id", "session-id", "session_id", "x-session-affinity", "x-opencode-session",
];
const SESSION_FIELDS = ["session_id", "sessionId", "prompt_cache_key"];

export function consumeSessionIdentity(headers: Record<string, string>, body: Record<string, unknown>): string | undefined {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const candidates: unknown[] = SESSION_HEADERS.map(key => normalized.get(key));
  candidates.push(...SESSION_FIELDS.map(key => body[key]));
  const metadata = body.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const fields = metadata as Record<string, unknown>;
    candidates.push(fields.session_id, fields.sessionId);
    delete fields.session_id;
    delete fields.sessionId;
    delete fields.prompt_cache_key;
  }
  for (const key of Object.keys(headers)) {
    const name = key.toLowerCase();
    // Pi can put a session ID here, but other clients use a new ID per request.
    if (SESSION_HEADERS.includes(name) || name === "x-client-request-id") delete headers[key];
  }
  for (const key of SESSION_FIELDS) delete body[key];
  // Bound untrusted local metadata; never use it as an upstream routing key.
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
