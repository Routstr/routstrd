import { describe, expect, test } from "bun:test";
import {
  formatRequestSummary, formatRequestVerbose, loadRequestTraces,
  RequestLogFollower, requestLogsQuery, safeCorrelatedLog,
  type LifecycleTrace,
} from "./request-logs";

const id = "11111111-2222-4333-8444-555555555555";
function trace(): LifecycleTrace {
  return {
    request: { requestId: id, clientId: "alice", requestedModelId: "deepseek-v4.1-flash", startedAt: 1000, outcome: "succeeded" },
    attempts: [400, 402, 200].map((status, i) => ({
      ordinal: i + 1, attemptId: `attempt-${i}`, baseUrl: "https://provider.test/v1", startedAt: 1000 + i * 1000,
      headersReceivedAt: 1500 + i * 1000, httpStatus: status, outcome: status === 200 ? "succeeded" : "failed", nodeRequestId: `node-${i}`,
    })),
    events: [{ sequence: 1, timestamp: 1000, type: "request_started" }, { sequence: 2, timestamp: 1800, type: "provider_failover", data: { from: "https://a.test", to: "https://b.test", prompt: "TOP SECRET" } }],
  };
}

describe("lifecycle logs rendering", () => {
  test("exact one-line summary, ordered by actual attempt ordinal with full UUID", () => {
    const t = trace(); t.attempts.reverse();
    expect(formatRequestSummary(t)).toBe(`alice - deepseek-v4.1-flash - 400 - 402 - 200 - ${id}`);
    expect(t.attempts[0]!.ordinal).toBe(3); // formatter does not mutate DB results
  });
  test("failed ingress preserves client attribution and local status without an attempt", () => {
    const t = trace(); t.attempts = []; t.request.outcome = "failed"; t.request.httpStatus = 400;
    expect(formatRequestSummary(t)).toBe(`alice - deepseek-v4.1-flash - 400 - ${id}`);
    delete t.request.httpStatus;
    expect(formatRequestSummary(t)).toContain(" - FAILED - ");
    delete t.request.clientId; delete t.request.requestedModelId;
    expect(formatRequestSummary(t)).toStartWith("unknown - unknown - ");
  });
  test("network failures have NET, cancellation and active calls have explicit labels", () => {
    const t = trace(); t.attempts.forEach(a => delete a.httpStatus);
    t.attempts[1]!.outcome = "aborted"; t.attempts[2]!.outcome = "in_progress";
    expect(formatRequestSummary(t)).toContain(" - NET - ABORTED - IN_PROGRESS - ");
  });
  test("verbose sorts events, attempts and correlated daemon/SDK messages chronologically", () => {
    const t = trace(); t.events.reverse(); t.attempts.reverse();
    const rendered = formatRequestVerbose(t, [
      `[1970-01-01T00:00:02.200Z] [INFO] [req:${id}:RoutstrClient] Retrying provider with private detail`,
      `[1970-01-01T00:00:00.100Z] [INFO] [req:other] Routing request with path: /v1`,
      `[1970-01-01T00:00:01.100Z] [INFO] [req:${id}] [model:m] Routing request with path: /v1`,
    ]);
    expect(rendered.split("\n").map(l => l.slice(0, 14))).toEqual([
      "alice - deepse", "  00:00:01.000", "  00:00:01.100", "  00:00:01.500", "  00:00:01.800", "  00:00:02.200", "  00:00:02.500", "  00:00:03.500",
    ]);
    expect(rendered).toContain("log [INFO] Retrying");
    expect(rendered).toContain("node_request_id=node-2");
    expect(rendered).not.toContain("private detail");
    expect(rendered).not.toContain("TOP SECRET");
    expect(rendered).not.toContain("req:other");
  });
  test("verbose refuses provider-controlled node ids that are not opaque tokens", () => {
    const t = trace();
    // x-routstr-request-id is a provider header, so its value is untrusted.
    t.attempts[0]!.nodeRequestId = "Bearer sk-live-secret free-form provider text";
    t.attempts[1]!.nodeRequestId = "node-2";
    t.attempts[2]!.nodeRequestId = "x".repeat(121);
    t.events = [{ sequence: 1, timestamp: 1000, type: "provider_selected", attemptId: "Bearer sk-attempt-secret" }];
    const rendered = formatRequestVerbose(t);
    expect(rendered).not.toContain("sk-live-secret");
    expect(rendered).not.toContain("sk-attempt-secret");
    expect(rendered).not.toContain("free-form provider text");
    expect(rendered).not.toContain("x".repeat(121));
    expect(rendered).toContain("node_request_id=node-2");
    expect(rendered).not.toContain("attempt_id=");
  });
  test("verbose picks up the SDK's _handleErrorResponse retry and failover lines", () => {
    const t = trace();
    const lines = [
      `[1970-01-01T00:00:01.100Z] [INFO] [req:${id}] [RoutstrClient] _handleErrorResponse: Retrying 402 (attempt 1/2)`,
      `[1970-01-01T00:00:01.200Z] [INFO] [req:${id}] [RoutstrClient] _handleErrorResponse: Failing over to next provider: https://b.test, model: m`,
    ];
    const rendered = formatRequestVerbose(t, lines);
    expect(rendered).toContain("log [INFO] Retrying");
    expect(rendered).toContain("log [INFO] Failing over");
    // Variable suffixes still never reach the terminal.
    expect(rendered).not.toContain("attempt 1/2");
    expect(rendered).not.toContain("next provider");
    expect(safeCorrelatedLog(lines[0]!, id)).toEqual({ timestamp: 1_100, message: "log [INFO] Retrying" });
  });
  test("verbose excludes raw payloads, credentials, unknown messages and continuations", () => {
    const t = trace(); t.attempts[0]!.baseUrl = "https://user:password@node.test/v1?api_key=SECRET";
    const payloads = [
      `[1970-01-01T00:00:01.100Z] [INFO] [req:${id}] {"messages":["PROMPT"]}`,
      `[1970-01-01T00:00:01.100Z] [INFO] [req:${id}] Response body: COMPLETION`,
      `[1970-01-01T00:00:01.100Z] [INFO] [req:${id}] Authorization: Bearer SECRET`,
      `PROMPT`,
      `[1970-01-01T00:00:01.100Z] [INFO] [req:${id}] Retrying {"messages":["PROMPT"]}`,
    ];
    const rendered = formatRequestVerbose(t, payloads);
    for (const secret of ["PROMPT", "COMPLETION", "SECRET", "password", "Authorization"]) expect(rendered).not.toContain(secret);
    expect(rendered).toContain("provider=https://node.test/v1");
    expect(safeCorrelatedLog(payloads[0]!, id)).toBeUndefined();
    expect(safeCorrelatedLog(`[bad date] [INFO] [req:${id}] Retrying`, id)).toBeUndefined();
  });
  test("verbose includes terminal outcome/status and structured retry decisions", () => {
    const t = trace();
    t.events = [
      { sequence: 1, timestamp: 1000, type: "same_provider_retry", data: { reason: "max_tokens_exceeded", ordinal: 2, kind: "same_provider_retry", retryCount: 1, errorType: "invalid_request_error", errorCode: "context_length_exceeded", failurePhase: "response" } },
      { sequence: 2, timestamp: 2000, type: "provider_failover", data: { reason: "http_402", from: "https://a.test?secret=hidden", to: "https://b.test", failoverCount: 1 } },
      { sequence: 3, timestamp: 3000, type: "request_finished", data: { outcome: "failed", httpStatus: 402, durationMs: 2000 } },
    ];
    const rendered = formatRequestVerbose(t);
    expect(rendered).toContain("reason=max_tokens_exceeded errorType=invalid_request_error errorCode=context_length_exceeded kind=same_provider_retry failurePhase=response ordinal=2 retryCount=1");
    expect(rendered).toContain("from=https://a.test/ to=https://b.test/ reason=http_402 failoverCount=1");
    expect(rendered).toContain("request_finished outcome=failed status=402 durationMs=2000");
    expect(rendered).not.toContain("hidden");
  });
  test("verbose rejects malformed structured event fields and never dumps freeform errors", () => {
    const t = trace();
    t.events = [{ sequence: 1, timestamp: 1000, type: "request_finished", data: {
      outcome: "succeeded SECRET", kind: "invented", reason: '{"error":"RAW"}', errorType: "Bearer TOKEN", errorCode: "x".repeat(121),
      failurePhase: "invented", httpStatus: Infinity, ordinal: -1, retryCount: 1.5, durationMs: NaN,
      errorMessage: "PROMPT COMPLETION", envelope: { secret: "RAW" },
    } }];
    const line = formatRequestVerbose(t).split("\n").find(l => l.includes("request_finished"));
    expect(line).toBe("  00:00:01.000  request_finished");
    t.events[0]!.data = { status: 200, outcome: "succeeded", kind: "initial", ordinal: 1 };
    expect(formatRequestVerbose(t)).toContain("request_finished outcome=succeeded kind=initial status=200 ordinal=1");
  });
  test("terminal escape sequences cannot be injected via display fields", () => {
    const t = trace(); t.request.clientId = "alice\n\x1b[2J";
    expect(formatRequestSummary(t)).not.toContain("\n");
    expect(formatRequestSummary(t)).not.toContain("\x1b");
  });
});

describe("lifecycle logs querying and follow", () => {
  test("filters and limits are forwarded, with URL encoding", () => {
    expect(requestLogsQuery({ lines: "10", before: "200", after: "100", outcome: "failed", modelId: "a/b", clientId: "alice & bob", baseUrl: "https://a.test" }))
      .toBe("/requests?limit=10&before=200&after=100&outcome=failed&modelId=a%2Fb&baseUrl=https%3A%2F%2Fa.test&clientId=alice+%26+bob");
    expect(requestLogsQuery({ lines: "-1" })).toBe("/requests?limit=50");
    expect(requestLogsQuery({ lines: "100000" })).toBe("/requests?limit=1000");
  });
  test("loads DB traces, never reconstructs statuses from flat logs; newest first", async () => {
    const older = trace(); older.request.requestId = "older"; older.request.startedAt = 0;
    const paths: string[] = [];
    const results = [ { requests: [older.request, trace().request] }, older, trace() ];
    const traces = await loadRequestTraces({ lines: "2" }, async path => {
      paths.push(path);
      const next = results.shift()!;
      return "request" in next ? next : { output: next };
    });
    expect(paths).toEqual(["/requests?limit=2", "/requests/older", `/requests/${id}`]);
    expect(traces.map(t => t.request.requestId)).toEqual([id, "older"]);
  });
  test("request-id lookup fetches a single complete trace", async () => {
    const paths: string[] = [];
    const result = await loadRequestTraces({ lines: "50", requestId: "id/with space" }, async path => { paths.push(path); return { output: trace() }; });
    expect(paths).toEqual(["/requests/id%2Fwith%20space"]);
    expect(result).toHaveLength(1);
  });
  test("raw detail API envelope is accepted for request-id filtering", async () => {
    const result = await loadRequestTraces({ lines: "50", requestId: id }, async () => trace() as LifecycleTrace & { output?: unknown });
    expect(result).toEqual([trace()]);
  });
  test("old API error is visible rather than silently reverting to guessed log statuses", async () => {
    await expect(loadRequestTraces({ lines: "2" }, async () => ({ error: "lifecycle unavailable" }))).rejects.toThrow("lifecycle unavailable");
  });
  test("follow suppresses unchanged traces and emits updated status chains and late diagnostics", () => {
    const follower = new RequestLogFollower(); const t = trace();
    expect(follower.changed([t], false)).toHaveLength(1);
    expect(follower.changed([t], false)).toEqual([]);
    t.attempts[2]!.httpStatus = 500;
    expect(follower.changed([t], false)[0]).toContain("400 - 402 - 500");
    expect(follower.changed([t], true)).toHaveLength(1);
    expect(follower.changed([t], true)).toEqual([]);
    expect(follower.changed([t], true, [`[1970-01-01T00:00:04.000Z] [INFO] [req:${id}] Stream completed`])).toHaveLength(1);
  });
});
