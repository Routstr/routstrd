import { describe, expect, test } from "bun:test";
import { confidentialHttp2Options } from "./index";

describe("confidentialUpstream.http2 → SDK options", () => {
  test("on by default with the SDK defaults", () => {
    const o = confidentialHttp2Options(undefined);
    expect(o.enabled).toBe(true);
    expect(o.reuse).toBeUndefined();
    expect(o.maxConnectionsPerKey).toBeUndefined();
    expect(o.maxConnections).toBeUndefined();
    expect(o.maxIdleMs).toBeUndefined();
    expect(o.maxRequestsPerConnection).toBeUndefined();
    expect(typeof o.log).toBe("function");
    expect(typeof o.onRequest).toBe("function");
  });

  test("only a literal false turns it off", () => {
    expect(confidentialHttp2Options({ enabled: false }).enabled).toBe(false);
    expect(confidentialHttp2Options({ enabled: true }).enabled).toBe(true);
    expect(confidentialHttp2Options({}).enabled).toBe(true);
  });

  test("passes the reuse scope through and ignores an unknown one", () => {
    expect(confidentialHttp2Options({ reuse: "model" }).reuse).toBe("model");
    expect(confidentialHttp2Options({ reuse: "none" }).reuse).toBe("none");
    expect(confidentialHttp2Options({ reuse: "credential" }).reuse).toBe("credential");
    expect(confidentialHttp2Options({ reuse: "everything" as never }).reuse).toBeUndefined();
  });

  test("maps the limits and converts the idle time", () => {
    const o = confidentialHttp2Options({
      maxConnections: 2,
      maxTotal: 5,
      maxIdleSeconds: 60,
      maxRequestsPerConnection: 10,
    });
    expect(o.maxConnectionsPerKey).toBe(2);
    expect(o.maxConnections).toBe(5);
    expect(o.maxIdleMs).toBe(60_000);
    expect(o.maxRequestsPerConnection).toBe(10);
  });

  test("passes the largest accepted connection deposit through", () => {
    expect(confidentialHttp2Options({}).maxConnectionDepositMsat).toBeUndefined();
    expect(confidentialHttp2Options({ maxConnectionDepositMsat: 5000 }).maxConnectionDepositMsat).toBe(5000);
    // 0 is a value: accept no deposit at all.
    expect(confidentialHttp2Options({ maxConnectionDepositMsat: 0 }).maxConnectionDepositMsat).toBe(0);
    for (const bad of [-1, 1.5, "5000", null]) {
      expect(confidentialHttp2Options({ maxConnectionDepositMsat: bad as never }).maxConnectionDepositMsat).toBeUndefined();
    }
  });

  test("ignores limits that are not positive integers", () => {
    const o = confidentialHttp2Options({
      maxConnections: 0,
      maxTotal: -1,
      maxIdleSeconds: 0,
      maxRequestsPerConnection: 1.5,
    });
    expect(o.maxConnectionsPerKey).toBeUndefined();
    expect(o.maxConnections).toBeUndefined();
    expect(o.maxIdleMs).toBeUndefined();
    expect(o.maxRequestsPerConnection).toBeUndefined();
  });
});
