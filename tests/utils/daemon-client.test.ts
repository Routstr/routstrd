import { describe, expect, test } from "bun:test";
import {
  getDaemonBaseUrl,
  urlHost,
  urlHosts,
} from "../../src/utils/daemon-client";
import type { RoutstrdConfig } from "../../src/utils/config";

function config(host: string): RoutstrdConfig {
  return {
    port: 8008,
    host,
    provider: null,
    cocodPath: null,
  };
}

describe("daemon URL host formatting", () => {
  test("prefers IPv4 loopback for an IPv4 wildcard", () => {
    expect(urlHosts("0.0.0.0")).toEqual(["127.0.0.1", "[::1]"]);
    expect(getDaemonBaseUrl(config("0.0.0.0"))).toBe("http://127.0.0.1:8008");
  });

  test("prefers IPv6 loopback for an IPv6 wildcard", () => {
    expect(urlHosts("::")).toEqual(["[::1]", "127.0.0.1"]);
    expect(getDaemonBaseUrl(config("::"))).toBe("http://[::1]:8008");
  });

  test("brackets IPv6 literals", () => {
    expect(urlHost("2001:db8::1")).toBe("[2001:db8::1]");
    expect(getDaemonBaseUrl(config("2001:db8::1"))).toBe(
      "http://[2001:db8::1]:8008",
    );
  });

  test("does not bracket an already-bracketed IPv6 literal twice", () => {
    expect(urlHost("[::1]")).toBe("[::1]");
  });

  test("escapes an IPv6 zone identifier for use in a URL", () => {
    expect(urlHost("fe80::1%en0")).toBe("[fe80::1%25en0]");
  });

  test("leaves IPv4 addresses and hostnames unchanged", () => {
    expect(urlHost("127.0.0.1")).toBe("127.0.0.1");
    expect(urlHost("localhost")).toBe("localhost");
  });

  test("uses the default loopback when the host is absent", () => {
    expect(urlHost()).toBe("127.0.0.1");
  });

  test("preserves an explicitly configured daemon URL", () => {
    expect(
      getDaemonBaseUrl({
        ...config("::"),
        daemonUrl: "https://daemon.example/",
      }),
    ).toBe("https://daemon.example");
  });
});
