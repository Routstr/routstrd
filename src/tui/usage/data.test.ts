import { describe, expect, test } from "bun:test";
import { generateSecretKey, nip19 } from "nostr-tools";
import { DEFAULT_CONFIG, type RoutstrdConfig } from "../../utils/config.ts";
import type { callAuth } from "../../utils/daemon-client.ts";
import { npubFromSecretKey } from "../../utils/nip98.ts";
import { fetchMonthlyQuota, monthlyQuotaForNpub } from "./data.ts";

const SECRET = generateSecretKey();
const SELF = npubFromSecretKey(SECRET);
const OTHER = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const NSEC = nip19.nsecEncode(SECRET);

function config(overrides: Partial<RoutstrdConfig> = {}): RoutstrdConfig {
  return { ...DEFAULT_CONFIG, nsec: NSEC, authUrl: "https://proxy.test", ...overrides };
}

/** Stub `callAuth` that records paths and returns a fixed payload. */
function authStub(payload: unknown, calls: string[] = []) {
  return (async (path: string) => {
    calls.push(path);
    return payload as { output?: unknown; error?: string };
  }) as unknown as typeof callAuth;
}

describe("monthlyQuotaForNpub", () => {
  test("reads the signed-in npub's cap and current-month spend", () => {
    const response = {
      npubs: [
        { npub: SELF, name: null, role: "user", monthlyLimitSats: 5000, monthlyUsedSats: 1200 },
      ],
    };
    expect(monthlyQuotaForNpub(response, SELF)).toEqual({ limitSats: 5000, usedSats: 1200 });
  });

  test("accepts the wrapped { output: { npubs } } response shape", () => {
    const response = {
      output: {
        npubs: [
          { npub: SELF, monthlyLimitSats: 5000, monthlyUsedSats: 1200 },
        ],
      },
    };
    expect(monthlyQuotaForNpub(response, SELF)).toEqual({ limitSats: 5000, usedSats: 1200 });
  });

  test("treats zero as a real cap", () => {
    const response = { npubs: [{ npub: SELF, monthlyLimitSats: 0, monthlyUsedSats: 0 }] };
    expect(monthlyQuotaForNpub(response, SELF)).toEqual({ limitSats: 0, usedSats: 0 });
  });

  test("reports missing current-month spend as unknown instead of zero", () => {
    const response = { npubs: [{ npub: SELF, monthlyLimitSats: 5000 }] };
    expect(monthlyQuotaForNpub(response, SELF)).toEqual({ limitSats: 5000, usedSats: null });
  });

  test("hides an explicitly unlimited npub", () => {
    const response = { npubs: [{ npub: SELF, monthlyLimitSats: null, monthlyUsedSats: 1200 }] };
    expect(monthlyQuotaForNpub(response, SELF)).toBeNull();
  });

  test("hides an older proxy that does not report the cap field", () => {
    const response = { npubs: [{ npub: SELF, name: null, role: "user" }] };
    expect(monthlyQuotaForNpub(response, SELF)).toBeNull();
  });

  test("never falls back to another npub's entry", () => {
    const response = {
      npubs: [
        { npub: OTHER, name: "Admin", role: "admin", monthlyLimitSats: 100_000, monthlyUsedSats: 900 },
        { npub: SELF, name: null, role: "user" },
      ],
    };
    expect(monthlyQuotaForNpub(response, SELF)).toBeNull();
  });

  test("matches the exact npub even when an admin entry comes first", () => {
    const response = {
      npubs: [
        { npub: OTHER, name: "Admin", role: "admin", monthlyLimitSats: 100_000, monthlyUsedSats: 900 },
        { npub: SELF, name: null, role: "user", monthlyLimitSats: 5000, monthlyUsedSats: 1200 },
      ],
    };
    expect(monthlyQuotaForNpub(response, SELF)).toEqual({ limitSats: 5000, usedSats: 1200 });
  });

  test("needs a signed-in identity", () => {
    const response = { npubs: [{ npub: SELF, monthlyLimitSats: 5000, monthlyUsedSats: 1200 }] };
    expect(monthlyQuotaForNpub(response, null)).toBeNull();
  });
});

describe("fetchMonthlyQuota", () => {
  test("asks the auth proxy for /npubs and returns the signed-in cap", async () => {
    const calls: string[] = [];
    const quota = await fetchMonthlyQuota({
      loadConfig: async () => config(),
      callAuth: authStub(
        { npubs: [{ npub: SELF, monthlyLimitSats: 5000, monthlyUsedSats: 1200 }] },
        calls,
      ),
    });

    expect(calls).toEqual(["/npubs"]);
    expect(quota).toEqual({ limitSats: 5000, usedSats: 1200 });
  });

  test("does nothing in local mode, where there is no auth proxy", async () => {
    const calls: string[] = [];
    const quota = await fetchMonthlyQuota({
      loadConfig: async () => ({ ...DEFAULT_CONFIG, nsec: NSEC }),
      callAuth: authStub({ npubs: [] }, calls),
    });

    expect(calls).toEqual([]);
    expect(quota).toBeNull();
  });

  test("asks when only a remote daemon URL is configured", async () => {
    const calls: string[] = [];
    const quota = await fetchMonthlyQuota({
      loadConfig: async () =>
        config({ authUrl: undefined, daemonUrl: "https://proxy.test" }),
      callAuth: authStub(
        { npubs: [{ npub: SELF, monthlyLimitSats: 5000, monthlyUsedSats: 1200 }] },
        calls,
      ),
    });

    expect(calls).toEqual(["/npubs"]);
    expect(quota).toEqual({ limitSats: 5000, usedSats: 1200 });
  });

  test("does nothing without a Nostr identity", async () => {
    const calls: string[] = [];
    const quota = await fetchMonthlyQuota({
      loadConfig: async () => config({ nsec: undefined }),
      callAuth: authStub({ npubs: [] }, calls),
    });

    expect(calls).toEqual([]);
    expect(quota).toBeNull();
  });

  test("hides the figure when the proxy call fails", async () => {
    const quota = await fetchMonthlyQuota({
      loadConfig: async () => config(),
      callAuth: authStub({ error: "Not found." }),
    });
    expect(quota).toBeNull();
  });

  test("hides the figure when the proxy throws", async () => {
    const quota = await fetchMonthlyQuota({
      loadConfig: async () => config(),
      callAuth: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof callAuth,
    });
    expect(quota).toBeNull();
  });

  test("does not carry a cap over to a different identity", async () => {
    // The proxy still lists the previous identity's capped npub; the current
    // config points at a different one, so nothing must be shown.
    const quota = await fetchMonthlyQuota({
      loadConfig: async () => config(),
      callAuth: authStub(
        { npubs: [{ npub: OTHER, monthlyLimitSats: 5000, monthlyUsedSats: 1200 }] },
      ),
    });
    expect(quota).toBeNull();
  });

  test("hides an uncapped or older-proxy entry", async () => {
    const unlimited = await fetchMonthlyQuota({
      loadConfig: async () => config(),
      callAuth: authStub({ npubs: [{ npub: SELF, monthlyLimitSats: null }] }),
    });
    const olderProxy = await fetchMonthlyQuota({
      loadConfig: async () => config(),
      callAuth: authStub({ npubs: [{ npub: SELF, name: null, role: "user" }] }),
    });

    expect(unlimited).toBeNull();
    expect(olderProxy).toBeNull();
  });
});
