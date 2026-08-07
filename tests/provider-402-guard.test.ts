import { describe, expect, test } from "bun:test";
import {
  classifyProvider402,
  createProvider402Guard,
} from "../src/daemon/wallet/provider-402-guard";

// The two bodies below are verbatim from the 2026-07-30 incident logs.
const PROVIDER_SIDE_402 = JSON.stringify({
  error: {
    message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
    code: 402,
    metadata: {
      limit_source: "openrouter_credits",
      remedy_hint:
        "Add credits at https://openrouter.ai/settings/credits, or lower max_tokens / prompt size to fit your remaining balance.",
    },
  },
});

const OUR_BALANCE_402 = JSON.stringify({
  detail: {
    error: {
      message:
        "Insufficient balance: 19409.897 sats (19409897 msats) required for this model; 9 sats (9000 msats) available.",
      type: "insufficient_quota",
      code: "insufficient_balance",
    },
  },
  request_id: "6e67c021-35c2-4f2c-80ed-181048a1c59b",
});

describe("classifyProvider402", () => {
  test("recognises the provider's own credit exhaustion", () => {
    expect(classifyProvider402(PROVIDER_SIDE_402)).toBe("provider_side");
  });

  test("recognises our own API-key shortfall", () => {
    expect(classifyProvider402(OUR_BALANCE_402)).toBe("our_balance");
  });

  test("does not confuse 'credits' with 'balance'", () => {
    // Both say "Insufficient ..." — only the noun distinguishes them.
    expect(classifyProvider402('{"error":{"message":"Insufficient credits."}}')).toBe(
      "provider_side",
    );
    expect(classifyProvider402('{"detail":"Insufficient balance: 10 sats required"}')).toBe(
      "our_balance",
    );
  });

  test("treats unrecognised and empty bodies as fundable", () => {
    // Refusing by default would break providers whose 402 shape we have not
    // seen; the rolling cap is what bounds the damage in this case.
    expect(classifyProvider402("")).toBe("unknown");
    expect(classifyProvider402(undefined)).toBe("unknown");
    expect(classifyProvider402("gateway timeout")).toBe("unknown");
    expect(classifyProvider402('{"detail":"something else"}')).toBe("unknown");
  });

  test("finds limit_source at realistic nesting depth (4 levels)", () => {
    // Real 402 bodies nest 3-4 levels deep.
    const body = JSON.stringify({
      detail: { error: { metadata: { limit_source: "openrouter_credits" } } },
    });
    expect(classifyProvider402(body)).toBe("provider_side");
  });

  test("does not crash on adversarially deep nesting", () => {
    // 50 levels deep — well beyond the depth limit. The field is never found,
    // so it falls through to "unknown" instead of stack-overflowing.
    let nested: Record<string, unknown> = { limit_source: "openrouter_credits" };
    for (let i = 0; i < 50; i++) nested = { nested };
    expect(classifyProvider402(JSON.stringify(nested))).toBe("unknown");
  });
});

describe("provider 402 guard", () => {
  const PROVIDER = "http://localhost:8011/";

  test("refuses to fund a provider whose own credit is exhausted", () => {
    const guard = createProvider402Guard();
    guard.record402(PROVIDER, PROVIDER_SIDE_402);

    const decision = guard.evaluate(PROVIDER, 32480);
    expect(decision.allow).toBe(false);
    expect((decision as { reason: string }).reason).toContain("upstream credit is exhausted");
  });

  test("still funds a genuine balance shortfall", () => {
    const guard = createProvider402Guard();
    guard.record402(PROVIDER, OUR_BALANCE_402);
    expect(guard.evaluate(PROVIDER, 32480).allow).toBe(true);
  });

  test("replays the incident: the second top-up never happens", () => {
    // 23:46:58 topped up 32480 sats, 23:46:59 topped up 6823 more, both against
    // a provider returning the openrouter_credits 402. 39303 sats left the
    // wallet in 1.5s. With the guard, neither top-up is allowed.
    const guard = createProvider402Guard();
    guard.record402(PROVIDER, PROVIDER_SIDE_402);

    expect(guard.evaluate(PROVIDER, 32480).allow).toBe(false);
    expect(guard.evaluate(PROVIDER, 6823).allow).toBe(false);
  });

  test("caps cumulative spend when the 402 shape is unrecognised", () => {
    let clock = 1_000_000;
    const guard = createProvider402Guard({
      windowMs: 120_000,
      windowCapSats: 25_000,
      now: () => clock,
    });
    guard.record402(PROVIDER, "unrecognised gateway error");

    // A single expensive request is still allowed through, however large.
    expect(guard.evaluate(PROVIDER, 32_480).allow).toBe(true);
    guard.recordTopUp(PROVIDER, 32_480);

    // Anything further inside the window is refused.
    const second = guard.evaluate(PROVIDER, 6_823);
    expect(second.allow).toBe(false);
    expect((second as { reason: string }).reason).toContain("top-up cap reached");

    // Once the window rolls over, funding resumes.
    clock += 120_001;
    expect(guard.evaluate(PROVIDER, 6_823).allow).toBe(true);
  });

  test("caps are per provider, not global", () => {
    let clock = 1_000_000;
    const guard = createProvider402Guard({
      windowMs: 120_000,
      windowCapSats: 25_000,
      now: () => clock,
    });

    guard.recordTopUp(PROVIDER, 24_000);
    expect(guard.evaluate(PROVIDER, 5_000).allow).toBe(false);
    expect(guard.evaluate("https://routstr.otrta.me/", 5_000).allow).toBe(true);
  });

  test("a successful request clears the provider's recorded 402", () => {
    const guard = createProvider402Guard();
    guard.record402(PROVIDER, PROVIDER_SIDE_402);
    expect(guard.evaluate(PROVIDER, 100).allow).toBe(false);

    guard.clear(PROVIDER);
    expect(guard.evaluate(PROVIDER, 100).allow).toBe(true);
  });
});
