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
function provider(value: string): string {
  try {
    const url = new URL(value);
    // Never print URL credentials or query parameters.
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "unknown";
  }
}
export function formatRequestSummary(trace: LifecycleTrace): string {
  const statuses = [...trace.attempts].sort((a, b) => a.ordinal - b.ordinal)
    .map((attempt) => attempt.httpStatus !== undefined ? String(attempt.httpStatus)
      : attempt.outcome === "in_progress" ? "IN_PROGRESS"
      : attempt.outcome === "aborted" ? "ABORTED" : "NET");
  const request = trace.request;
  const chain = statuses.length ? statuses.join(" - ")
    : request.httpStatus !== undefined ? String(request.httpStatus) : request.outcome.toUpperCase();
  return `${text(request.clientId || "unknown")} - ${text(request.requestedModelId || "unknown")} - ${chain} - ${text(request.requestId)}`;
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
  const message = match[3]!.slice(tags.length);
  // Whitelist operational prefixes, not arbitrary request-scoped messages.
  if (!/^(Routing request with path|Provider selected|Selected provider|Retrying|Failover|Failing over|Top-?up (?:started|succeeded|completed)|Stream (?:completed|cancelled)|Request (?:started|completed|aborted))\b/i.test(message)) return;
  // Keep only the diagnostic label. Variable suffixes can contain raw upstream
  // envelopes or caller-controlled text even in otherwise useful SDK logs.
  const label = message.match(/^(Routing request with path|Provider selected|Selected provider|Retrying|Failover|Failing over|Top-?up (?:started|succeeded|completed)|Stream (?:completed|cancelled)|Request (?:started|completed|aborted))/i)![0];
  return { timestamp, message: `log [${text(match[2])}] ${label}` };
}

export function formatRequestVerbose(trace: LifecycleTrace, logLines: string[] = []): string {
  const timeline: { timestamp: number; order: number; message: string }[] = [];
  for (const attempt of trace.attempts) {
    const details = [
      `attempt=${attempt.ordinal}`, `provider=${provider(attempt.baseUrl)}`,
      attempt.kind && `kind=${text(attempt.kind)}`,
      `status=${attempt.httpStatus ?? (attempt.outcome === "in_progress" ? "IN_PROGRESS" : attempt.outcome === "aborted" ? "ABORTED" : "NET")}`,
      `outcome=${text(attempt.outcome)}`,
      attempt.failurePhase && `phase=${text(attempt.failurePhase)}`,
      (attempt.errorType || attempt.errorCode) && `error=${text([attempt.errorType, attempt.errorCode].filter(Boolean).join("/"))}`,
      attempt.nodeRequestId && `node_request_id=${text(attempt.nodeRequestId)}`,
    ].filter(Boolean).join(" ");
    timeline.push({ timestamp: attempt.headersReceivedAt ?? attempt.endedAt ?? attempt.startedAt, order: attempt.ordinal, message: details });
  }
  for (const event of trace.events) {
    const details = [text(event.type), event.baseUrl && `provider=${provider(event.baseUrl)}`,
      event.attemptId && `attempt_id=${text(event.attemptId)}`];
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
  for (const line of logLines) {
    const safe = safeCorrelatedLog(line, trace.request.requestId);
    if (safe) timeline.push({ ...safe, order: Number.MAX_SAFE_INTEGER });
  }
  timeline.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
  return [formatRequestSummary(trace), ...timeline.map((entry) =>
    `  ${new Date(entry.timestamp).toISOString().slice(11, 23)}  ${entry.message}`)].join("\n");
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
  const query = new URLSearchParams({ limit: String(Number.isInteger(count) && count > 0 ? Math.min(count, 1000) : 50) });
  for (const key of ["before", "after", "outcome", "modelId", "baseUrl", "clientId"] as const) {
    if (options[key] !== undefined) query.set(key, options[key]!);
  }
  return `/requests?${query}`;
}

export async function loadRequestTraces(
  options: RequestLogFilters,
  call: (path: string) => Promise<unknown>,
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
  return traces.sort((a, b) => b.request.startedAt - a.request.startedAt || b.request.requestId.localeCompare(a.request.requestId));
}

/** Follow emits a replacement summary when a request changes, without duplicating
 * unchanged traces. It also catches late diagnostics on the verbose path. */
export class RequestLogFollower {
  private seen = new Map<string, string>();
  changed(traces: LifecycleTrace[], verbose: boolean, logs: string[] = []): string[] {
    const output: string[] = [];
    for (const trace of traces) {
      const rendered = verbose ? formatRequestVerbose(trace, logs) : formatRequestSummary(trace);
      if (this.seen.get(trace.request.requestId) !== rendered) output.push(rendered);
      this.seen.set(trace.request.requestId, rendered);
    }
    // Bound state during long-running follow sessions.
    while (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value!);
    return output;
  }
}
