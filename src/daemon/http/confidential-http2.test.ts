import { describe, expect, test } from "bun:test";
import {
  confidentialErrorStatus,
  confidentialFraming,
  confidentialHttp2Options,
  confidentialMaxDeposit,
  confidentialReuseScope,
  noteOutdatedNode,
} from "./index";

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
});

describe("the connection deposit maximum", () => {
  test("is read from either place; 0 is a value; anything else leaves the SDK's default", () => {
    expect(confidentialMaxDeposit({})).toBeUndefined();
    expect(confidentialMaxDeposit({ maxConnectionDepositMsat: 5000 })).toBe(5000);
    expect(confidentialMaxDeposit({ http2: { maxConnectionDepositMsat: 4000 } })).toBe(4000);
    expect(confidentialMaxDeposit({ maxConnectionDepositMsat: 5000, http2: { maxConnectionDepositMsat: 4000 } })).toBe(5000);
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
