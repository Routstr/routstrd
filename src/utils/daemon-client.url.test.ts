import { describe, expect, test } from "bun:test";
import {
  baseUrlCandidates,
  getAuthBaseUrl,
  getDaemonBaseUrl,
  normalizeBaseUrl,
} from "./daemon-client";
import { DEFAULT_CONFIG } from "./config";

describe("normalizeBaseUrl", () => {
  test("adds http:// when the scheme is omitted", () => {
    // `new URL("localhost:18008")` parses "localhost:" as the scheme, so this
    // must be repaired before it reaches fetch.
    expect(normalizeBaseUrl("localhost:18008")).toBe("http://localhost:18008");
    expect(normalizeBaseUrl("127.0.0.1:8008")).toBe("http://127.0.0.1:8008");
    expect(normalizeBaseUrl("daemon.example")).toBe("http://daemon.example");
  });

  test("adds http:// for a bracketed IPv6 host without a scheme", () => {
    expect(normalizeBaseUrl("[::1]:8008")).toBe("http://[::1]:8008");
  });

  test("preserves an explicit scheme", () => {
    expect(normalizeBaseUrl("https://daemon.example")).toBe("https://daemon.example");
    expect(normalizeBaseUrl("http://127.0.0.1:18008")).toBe("http://127.0.0.1:18008");
  });

  test("trims whitespace and trailing slashes", () => {
    expect(normalizeBaseUrl("  http://localhost:18008/  ")).toBe("http://localhost:18008");
    expect(normalizeBaseUrl("localhost:18008///")).toBe("http://localhost:18008");
  });
});

describe("baseUrlCandidates", () => {
  test("offers both loopback families for localhost", () => {
    expect(baseUrlCandidates("localhost:18008")).toEqual([
      "http://localhost:18008",
      "http://127.0.0.1:18008",
      "http://[::1]:18008",
    ]);
  });

  test("leaves non-loopback hosts alone", () => {
    expect(baseUrlCandidates("http://daemon.example:8008")).toEqual([
      "http://daemon.example:8008",
    ]);
  });
});

describe("remote base URL resolution", () => {
  test("normalizes a legacy scheme-less daemonUrl", () => {
    expect(getDaemonBaseUrl({ ...DEFAULT_CONFIG, daemonUrl: "localhost:18008" })).toBe(
      "http://localhost:18008",
    );
  });

  test("normalizes authUrl and falls back to daemonUrl", () => {
    expect(
      getAuthBaseUrl({ ...DEFAULT_CONFIG, daemonUrl: "localhost:18008", authUrl: "localhost:9000" }),
    ).toBe("http://localhost:9000");
    expect(getAuthBaseUrl({ ...DEFAULT_CONFIG, daemonUrl: "localhost:18008" })).toBe(
      "http://localhost:18008",
    );
  });
});
