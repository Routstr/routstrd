import { describe, expect, test } from "bun:test";
import {
  confidentialErrorStatus,
  confidentialFraming,
  confidentialHttp2Options,
  confidentialMaxDeposit,
  confidentialPadBucket,
  confidentialReuseScope,
  confidentialWarningSink,
  noteOutdatedNode,
} from "./index";
import { parseConfidentialReuseScope } from "./confidential-opt-in";

describe("confidentialUpstream.http → the SDK's framing choice", () => {
  test("auto unless a framing is named", () => {
    expect(confidentialFraming(undefined)).toBe("auto");
    expect(confidentialFraming("auto")).toBe("auto");
    expect(confidentialFraming("2")).toBe("2");
    expect(confidentialFraming("1.1")).toBe("1.1");
    // Not a framing: the default, never a guess.
    for (const bad of [2, 1.1, "h2", "http/1.1", "", null, true]) expect(confidentialFraming(bad)).toBe("auto");
  });
});

describe("confidentialUpstream.http2 → SDK http2 options", () => {
  test("defaults: shared within a scope, limits left to the SDK", () => {
    const o = confidentialHttp2Options(undefined);
    expect(o.reuse).toBe("shared");
    expect(o.maxConnectionsPerKey).toBeUndefined();
    expect(o.maxConnections).toBeUndefined();
    expect(o.maxIdleMs).toBeUndefined();
    expect(o.maxRequestsPerConnection).toBeUndefined();
    expect(typeof o.log).toBe("function");
    expect(typeof o.onRequest).toBe("function");
  });

  test("reuse none is a connection per request; per-client and shared pool within the scope", () => {
    expect(confidentialHttp2Options({ reuse: "none" }).reuse).toBe("none");
    expect(confidentialHttp2Options({ reuse: "shared" }).reuse).toBe("shared");
    expect(confidentialHttp2Options({ reuse: "per-client" }).reuse).toBe("shared");
    expect(confidentialHttp2Options({ reuse: "everything" as never }).reuse).toBe("shared");
  });

  test("maps the limits and seconds to milliseconds", () => {
    const o = confidentialHttp2Options({ maxConnections: 2, maxTotal: 5, maxIdleSeconds: 60, maxRequestsPerConnection: 10 });
    expect(o.maxConnectionsPerKey).toBe(2);
    expect(o.maxConnections).toBe(5);
    expect(o.maxIdleMs).toBe(60_000);
    expect(o.maxRequestsPerConnection).toBe(10);
  });

  test("ignores values that are not positive integers", () => {
    const o = confidentialHttp2Options({
      maxConnections: 0,
      maxTotal: -1,
      maxIdleSeconds: 0,
      maxRequestsPerConnection: 1.5,
    } as never);
    expect(o.maxConnectionsPerKey).toBeUndefined();
    expect(o.maxConnections).toBeUndefined();
    expect(o.maxIdleMs).toBeUndefined();
    expect(o.maxRequestsPerConnection).toBeUndefined();
  });

  test("onRequest logs through the request's sink; the pool's log does not", () => {
    const lines: string[] = [];
    const o = confidentialHttp2Options({}, (m) => lines.push(m));
    o.log("connection opened");
    o.onRequest({ status: 200, reused: true });
    // The SDK keeps one pool per process and each request's options replace the
    // last ones, so the pool's lines must not carry one request's id.
    expect(lines).toEqual([`[confidential] request ${"{\"status\":200,\"reused\":true}"}`]);
  });
});

describe("the connection deposit maximum", () => {
  test("is read from the top level only; 0 is a value; anything else leaves the SDK's default", () => {
    expect(confidentialMaxDeposit({})).toBeUndefined();
    expect(confidentialMaxDeposit({ maxConnectionDepositMsat: 5000 })).toBe(5000);
    // The unreleased http2 place of the setting is not read.
    expect(confidentialMaxDeposit({ http2: { maxConnectionDepositMsat: 4000 } } as never)).toBeUndefined();
    // 0 accepts no deposit: only nodes that take none are used.
    expect(confidentialMaxDeposit({ maxConnectionDepositMsat: 0 })).toBe(0);
    for (const bad of [-1, 1.5, "5000", null]) {
      expect(confidentialMaxDeposit({ maxConnectionDepositMsat: bad as never })).toBeUndefined();
    }
  });
});

describe("the reuse scope of a request (per-client by default)", () => {
  const req = (headers: Record<string, string>, remoteAddress = "127.0.0.1") => ({ headers, socket: { remoteAddress } });

  test("two local API keys get two scopes; the same key the same scope", () => {
    const a = confidentialReuseScope(undefined, req({ authorization: "Bearer sk-aaa" }));
    const b = confidentialReuseScope(undefined, req({ authorization: "Bearer sk-bbb" }));
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
    expect(confidentialReuseScope("per-client", req({ authorization: "Bearer sk-aaa" }, "10.0.0.9"))).toBe(a);
    // The key itself never leaves: only a hash.
    expect(a).not.toContain("sk-aaa");
    expect(a).toMatch(/^client-[0-9a-f]{32}$/);
    expect(confidentialReuseScope(undefined, req({ "x-api-key": "sk-aaa" }))).toBe(a);
  });

  test("without a key the remote address is the client", () => {
    const local = confidentialReuseScope(undefined, req({}));
    const other = confidentialReuseScope(undefined, req({}, "192.168.1.7"));
    expect(local).toBeDefined();
    expect(local).not.toBe(other);
    expect(confidentialReuseScope(undefined, req({}))).toBe(local);
    // A key and an address never collide.
    expect(confidentialReuseScope(undefined, req({ authorization: "Bearer 127.0.0.1" }))).not.toBe(local);
  });

  test("shared and none name no scope; an unknown value keeps the narrower per-client scope", () => {
    expect(confidentialReuseScope("shared", req({ authorization: "Bearer sk-aaa" }))).toBeUndefined();
    // A caller's own scope narrows (never widens) the reuse scope.
    const conv1 = confidentialReuseScope(undefined, req({ authorization: "Bearer sk-aaa", "x-routstr-reuse-scope": "conv-1" }));
    const conv2 = confidentialReuseScope(undefined, req({ authorization: "Bearer sk-aaa", "x-routstr-reuse-scope": "conv-2" }));
    const otherKey = confidentialReuseScope(undefined, req({ authorization: "Bearer sk-bbb", "x-routstr-reuse-scope": "conv-1" }));
    const plain = confidentialReuseScope(undefined, req({ authorization: "Bearer sk-aaa" }));
    expect(new Set([plain, conv1, conv2, otherKey]).size).toBe(4);
    expect(confidentialReuseScope("shared", req({ "x-routstr-reuse-scope": "conv-1" }))).toMatch(/^scope-/);
    expect(confidentialReuseScope("none", req({ "x-routstr-reuse-scope": "conv-1" }))).toBeUndefined();
    expect(confidentialReuseScope("none", req({ authorization: "Bearer sk-aaa" }))).toBeUndefined();
    expect(confidentialReuseScope("everything", req({ authorization: "Bearer sk-aaa" }))).toBeDefined();
  });
});

describe("node_protocol_outdated", () => {
  test("is logged once per node per day", () => {
    const t0 = 1_800_000_000_000;
    expect(noteOutdatedNode("https://old-node.example/", 2, t0)).toBe(true);
    expect(noteOutdatedNode("https://old-node.example", 2, t0 + 60_000)).toBe(false);
    expect(noteOutdatedNode("https://old-node.example", 2, t0 + 23 * 3_600_000)).toBe(false);
    expect(noteOutdatedNode("https://other-old-node.example", 2, t0 + 60_000)).toBe(true);
    expect(noteOutdatedNode("https://old-node.example", 2, t0 + 24 * 3_600_000)).toBe(true);
  });

  test("reaches the caller in the error body when no node can serve the request", () => {
    const e = Object.assign(new Error("node_protocol_outdated: the node offers routstr-confidential v2, this client speaks v3"), {
      code: "node_protocol_outdated",
    });
    expect(confidentialErrorStatus(e)).toEqual({ status: 502, code: "node_protocol_outdated" });
    for (const code of ["upgrade_required", "twopc_version_mismatch"]) {
      expect(confidentialErrorStatus(Object.assign(new Error(code), { code }))).toEqual({ status: 502, code });
    }
  });
});

describe("x-routstr-reuse-scope is one value of 1 to 256 bytes", () => {
  const req = (headers: Record<string, string | string[]>, rawHeaders?: string[]) => ({ headers, rawHeaders });

  test("absent, or one value: accepted", () => {
    expect(parseConfidentialReuseScope(req({}, []))).toEqual({ kind: "absent" });
    expect(parseConfidentialReuseScope(req({ "x-routstr-reuse-scope": "conv-1" }, ["X-Routstr-Reuse-Scope", "conv-1"]))).toEqual({
      kind: "scope",
      value: "conv-1",
    });
    const max = "a".repeat(256);
    expect(parseConfidentialReuseScope(req({ "x-routstr-reuse-scope": max }, ["x-routstr-reuse-scope", max])).kind).toBe("scope");
  });

  test("a repeated header, an empty value or one over 256 bytes is refused, never ignored", () => {
    // Node joins a repeated header with ", ": only the raw lines tell.
    const repeated = req({ "x-routstr-reuse-scope": "a, b" }, ["x-routstr-reuse-scope", "a", "X-Routstr-Reuse-Scope", "b"]);
    const long = "a".repeat(257);
    const longBytes = "é".repeat(129); // 258 bytes in 129 characters
    for (const r of [
      repeated,
      req({ "x-routstr-reuse-scope": ["a", "b"] }),
      req({ "x-routstr-reuse-scope": "" }, ["x-routstr-reuse-scope", ""]),
      req({ "x-routstr-reuse-scope": long }, ["x-routstr-reuse-scope", long]),
      req({ "x-routstr-reuse-scope": longBytes }, ["x-routstr-reuse-scope", longBytes]),
    ]) {
      const p = parseConfidentialReuseScope(r);
      expect(p.kind).toBe("invalid");
      if (p.kind === "invalid") expect(p.error).toContain("x-routstr-reuse-scope");
    }
  });
});

describe("confidentialUpstream.padBucket and the warning sink", () => {
  test("padBucket: an integer of at least 16 bytes or pow2; anything else leaves padding off", () => {
    expect(confidentialPadBucket({})).toBeUndefined();
    expect(confidentialPadBucket({ padBucket: 4096 })).toBe(4096);
    expect(confidentialPadBucket({ padBucket: 16 })).toBe(16);
    expect(confidentialPadBucket({ padBucket: "pow2" } as never)).toBe("pow2");
    for (const bad of [0, 15, -1, 1.5, "4096", null, true]) {
      expect(confidentialPadBucket({ padBucket: bad as never })).toBeUndefined();
    }
  });

  test("an SDK warning is one line at warn level", () => {
    const lines: unknown[][] = [];
    const sink = confidentialWarningSink((...args: unknown[]) => lines.push(args));
    sink("deposit outcome disagrees\nwith the offer\r\n");
    expect(lines).toEqual([["[confidential] deposit outcome disagrees with the offer"]]);
  });
});
