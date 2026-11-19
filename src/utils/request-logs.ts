// The lifecycle API is the source of truth; flat logs only supplement its timeline.
export interface LifecycleSummary {
  requestId: string;
  clientId?: string;
  requestedModelId?: string;
  startedAt: number;
  updatedAt?: number;
  outcome: string;
  httpStatus?: number;
}
export interface LifecycleAttempt {
  ordinal: number;
  attemptId: string;
  startedAt: number;
  headersReceivedAt?: number;
  endedAt?: number;
  baseUrl: string;
  httpStatus?: number;
  outcome: string;
  kind?: string;
  errorType?: string;
  errorCode?: string;
  nodeRequestId?: string;
  failurePhase?: string;
  upstreamResponseId?: string;
  requestLogId?: string;
}
export interface LifecycleEvent {
  sequence: number;
  timestamp: number;
  type: string;
  attemptId?: string;
  baseUrl?: string;
  data?: Record<string, unknown>;
}
export interface LifecycleTrace {
  request: LifecycleSummary;
  attempts: LifecycleAttempt[];
  events: LifecycleEvent[];
}

// Escape terminal controls, including newlines, in untrusted display fields.
function text(value: unknown): string {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
/** Provider-controlled identifiers (node request ids) are not trusted: only a
 * short opaque token is displayable, since anything else may echo credentials or
 * a free-form upstream envelope. Same rule the SDK applies to structured codes. */
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : undefined;
}
function provider(value: string): string {
  try {
    const url = new URL(value);
    // Never print URL credentials or query parameters.
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "unknown";
  }
}
/** UTC time of day, matching the `[ISO]` stamps the daemon writes to disk.
 * Deliberately date-free: a summary line is scrollback, and the daily log files
 * it supplements already carry the date. Non-finite input degrades to a
 * placeholder rather than throwing `RangeError` and killing the whole listing. */
export function utcTime(ms: number, withMillis = false): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, withMillis ? 23 : 19) : "--:--:--";
}
export function formatRequestSummary(trace: LifecycleTrace): string {
  const statuses = [...trace.attempts].sort((a, b) => a.ordinal - b.ordinal)
    .map((attempt) => attempt.httpStatus !== undefined ? String(attempt.httpStatus)
      : attempt.outcome === "in_progress" ? "IN_PROGRESS"
      : attempt.outcome === "aborted" ? "ABORTED" : "NET");
  const request = trace.request;
  const chain = statuses.length ? statuses.join(" - ")
    : request.httpStatus !== undefined ? String(request.httpStatus) : request.outcome.toUpperCase();
  return `${utcTime(request.startedAt)}  ${text(request.clientId || "unknown")} - ${text(request.requestedModelId || "unknown")} - ${chain} - ${text(request.requestId)}`;
}

/** Only known diagnostic messages are eligible. Drop payload-bearing suffixes,
 * unknown messages and multiline continuations, even when the raw sink is enabled.
 * --raw is the explicit legacy escape hatch, never implied by verbose. */
export function safeCorrelatedLog(line: string, requestId: string): { timestamp: number; message: string } | undefined {
  const match = line.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*)$/);
  if (!match || !match[3]!.includes(`[req:${requestId}]`) && !match[3]!.includes(`[req:${requestId}:`)) return;
  const timestamp = Date.parse(match[1]!);
  if (!Number.isFinite(timestamp)) return;
  const tags = match[3]!.match(/^(?:\[[^\]]+\]\s*)+/)?.[0] ?? "";
  // The SDK emits routing decisions through RoutstrClient's
  // `_handleErrorResponse: ` prefix; strip it so the whitelist still matches.
  const message = match[3]!.slice(tags.length).replace(/^_handleErrorResponse:\s*/i, "");
  // Whitelist operational prefixes, not arbitrary request-scoped messages.
  if (!/^(Routing request with path|Provider selected|Selected provider|Retrying|Failover|Failing over|Top-?up (?:started|succeeded|completed)|Stream (?:completed|cancelled)|Request (?:started|completed|aborted))\b/i.test(message)) return;
  // Keep only the diagnostic label. Variable suffixes can contain raw upstream
  // envelopes or caller-controlled text even in otherwise useful SDK logs.
  const label = message.match(/^(Routing request with path|Provider selected|Selected provider|Retrying|Failover|Failing over|Top-?up (?:started|succeeded|completed)|Stream (?:completed|cancelled)|Request (?:started|completed|aborted))/i)![0];
  return { timestamp, message: `log [${text(match[2])}] ${label}` };
}

export interface CorrelatedDiagnostic { timestamp: number; message: string }
export type RequestDiagnostics = string[] | ReadonlyMap<string, readonly CorrelatedDiagnostic[]>;

export function formatRequestVerbose(trace: LifecycleTrace, logLines: RequestDiagnostics = []): string {
  const timeline: { timestamp: number; order: number; message: string }[] = [];
  for (const attempt of trace.attempts) {
    const kind = identifier(attempt.kind);
    const failurePhase = identifier(attempt.failurePhase);
    const errorType = identifier(attempt.errorType);
    const errorCode = identifier(attempt.errorCode);
    const nodeRequestId = identifier(attempt.nodeRequestId);
    const details = [
      `attempt=${attempt.ordinal}`, `provider=${provider(attempt.baseUrl)}`,
      kind && `kind=${kind}`,
      `status=${attempt.httpStatus ?? (attempt.outcome === "in_progress" ? "IN_PROGRESS" : attempt.outcome === "aborted" ? "ABORTED" : "NET")}`,
      `outcome=${text(attempt.outcome)}`,
      failurePhase && `phase=${failurePhase}`,
      (errorType || errorCode) && `error=${[errorType, errorCode].filter(Boolean).join("/")}`,
      // Never print a provider-supplied header value verbatim: it is not ours.
      nodeRequestId && `node_request_id=${nodeRequestId}`,
    ].filter(Boolean).join(" ");
    timeline.push({ timestamp: attempt.headersReceivedAt ?? attempt.endedAt ?? attempt.startedAt, order: attempt.ordinal, message: details });
  }
  for (const event of trace.events) {
    const eventAttemptId = identifier(event.attemptId);
    const details = [text(event.type), event.baseUrl && `provider=${provider(event.baseUrl)}`,
      eventAttemptId && `attempt_id=${eventAttemptId}`];
    // Never dump event objects. Only routing decision fields are displayed.
    for (const key of ["from", "to"] as const) {
      if (typeof event.data?.[key] === "string") details.push(`${key}=${provider(event.data[key])}`);
    }
    // Match SDK safeCode validation for known structured diagnostic fields.
    // Never print free-form errorMessage, payload objects, or arbitrary keys.
    for (const key of ["reason", "errorType", "errorCode"] as const) {
      const value = event.data?.[key];
      if (typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value)) details.push(`${key}=${value}`);
    }
    const enums = {
      outcome: ["in_progress", "succeeded", "failed", "aborted", "interrupted", "stream_error"],
      kind: ["initial", "same_provider_retry", "provider_failover", "mint_retry"],
      failurePhase: ["funding", "network", "response", "stream"],
    };
    for (const key of ["outcome", "kind", "failurePhase"] as const) {
      const value = event.data?.[key];
      if (typeof value === "string" && enums[key].includes(value)) details.push(`${key}=${value}`);
    }
    const status = event.data?.httpStatus ?? event.data?.status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) details.push(`status=${status}`);
    for (const key of ["ordinal", "retryCount", "failoverCount", "durationMs"] as const) {
      const value = event.data?.[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= (key === "ordinal" ? 1 : 0)) details.push(`${key}=${value}`);
    }
    timeline.push({ timestamp: event.timestamp, order: event.sequence, message: details.filter(Boolean).join(" ") });
  }
  const diagnostics = Array.isArray(logLines)
    ? logLines.flatMap(line => { const safe = safeCorrelatedLog(line, trace.request.requestId); return safe ? [safe] : []; })
    : logLines.get(trace.request.requestId) ?? [];
  for (const safe of diagnostics) timeline.push({ ...safe, order: Number.MAX_SAFE_INTEGER });
  timeline.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
  return [formatRequestSummary(trace), ...timeline.map((entry) =>
    `  ${utcTime(entry.timestamp, true)}  ${entry.message}`)].join("\n");
}

export interface RequestLogFilters {
  lines: string;
  requestId?: string;
  before?: string;
  after?: string;
  outcome?: string;
  modelId?: string;
  baseUrl?: string;
  clientId?: string;
}
export function requestLogsQuery(options: RequestLogFilters): string {
  const count = Number(options.lines);
  const query = new URLSearchParams({ limit: String(Number.isInteger(count) && count > 0 ? Math.min(count, 1000) : 7) });
  for (const key of ["before", "after", "outcome", "modelId", "baseUrl", "clientId"] as const) {
    if (options[key] !== undefined) query.set(key, options[key]!);
  }
  return `/requests?${query}`;
}

/** A request stays mutable while its lifecycle outcome is `in_progress`. Follow
 * must keep reading it even after newer requests push it out of the list window. */
function requestInFlight(trace: LifecycleTrace): boolean {
  return trace.request.outcome === "in_progress";
}

/** Upper bound on requests followed past the list window. Each one costs a
 * detail request per poll, so a leaked `in_progress` row cannot grow the load
 * without limit; the oldest are dropped first because a stuck row is the most
 * likely reason a slot is never freed. */
export const MAX_TRACKED_IN_FLIGHT = 100;

export async function loadRequestTraces(
  options: RequestLogFilters,
  call: (path: string) => Promise<unknown>,
  /** Ids to read individually when the list window no longer covers them. */
  carryOver: readonly string[] = [],
): Promise<LifecycleTrace[]> {
  const read = async (path: string): Promise<unknown> => {
    const result = await call(path) as { output?: unknown; error?: string; request?: unknown };
    if (result.error) throw new Error(result.error);
    // List uses the daemon's normal {output} envelope; trace detail follows
    // the public {request, attempts, events} contract directly.
    return result.output ?? ("request" in result ? result : undefined);
  };
  if (options.requestId) {
    const trace = await read(`/requests/${encodeURIComponent(options.requestId)}`);
    return trace ? [trace as LifecycleTrace] : [];
  }
  const output = await read(requestLogsQuery(options));
  const requests = (Array.isArray(output) ? output : (output as { requests?: LifecycleSummary[] } | undefined)?.requests) ?? [];
  const traces: LifecycleTrace[] = [];
  for (const request of requests as LifecycleSummary[]) {
    const trace = await read(`/requests/${encodeURIComponent(request.requestId)}`);
    if (trace) traces.push(trace as LifecycleTrace);
  }
  // The list is only ever the newest `limit` requests, so a request that was in
  // flight when newer ones arrived would otherwise never report its final state.
  const listed = new Set(traces.map(trace => trace.request.requestId));
  for (const requestId of carryOver) {
    if (listed.has(requestId)) continue;
    const trace = await read(`/requests/${encodeURIComponent(requestId)}`);
    if (trace) traces.push(trace as LifecycleTrace);
  }
  return traces.sort((a, b) => b.request.startedAt - a.request.startedAt || b.request.requestId.localeCompare(a.request.requestId));
}

/** Follow emits a replacement summary when a request changes, without duplicating
 * unchanged traces. It also catches late diagnostics on the verbose path.
 *
 * A stream cannot rewrite an already-printed line, so a state transition is
 * appended where it happened rather than where the request started. Rendered
 * updates carry an `(updated)` marker: without it a completed request reads as a
 * second, newer request sharing an older timestamp. */
export class RequestLogFollower {
  private seen = new Map<string, string>();
  /** Requests not yet terminal, so follow keeps reading them past the list window. */
  private inFlight = new Set<string>();
  changed(traces: LifecycleTrace[], verbose: boolean, logs: RequestDiagnostics = []): string[] {
    const output: string[] = [];
    for (const trace of traces) {
      const requestId = trace.request.requestId;
      const rendered = verbose ? formatRequestVerbose(trace, logs) : formatRequestSummary(trace);
      const previous = this.seen.get(requestId);
      if (previous !== rendered) output.push(previous === undefined ? rendered : markUpdated(rendered));
      this.seen.set(requestId, rendered);
      if (requestInFlight(trace)) this.inFlight.add(requestId);
      else this.inFlight.delete(requestId);
    }
    // Bound state during long-running follow sessions.
    while (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value!);
    while (this.inFlight.size > MAX_TRACKED_IN_FLIGHT) this.inFlight.delete(this.inFlight.values().next().value!);
    return output;
  }
  /** Ids of requests still in flight, to be carried past the newest-N window. */
  awaiting(): string[] {
    return [...this.inFlight];
  }
}

/** Flag a re-render on its first line so an appended transition is not read as a
 * duplicate of the earlier line it supersedes. Initial renders stay unchanged. */
function markUpdated(rendered: string): string {
  const newline = rendered.indexOf("\n");
  const head = newline === -1 ? rendered : rendered.slice(0, newline);
  return newline === -1 ? `${head}  (updated)` : `${head}  (updated)${rendered.slice(newline)}`;
}
