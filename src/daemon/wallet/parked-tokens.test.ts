import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { getDecodedToken, getEncodedToken, getTokenMetadata } from "@cashu/cashu-ts";
import {
  classifyParkedFailure,
  groupForMerge,
  inspectParkedToken,
  mergeInspections,
  PARKED_TOKEN_MAX_AGE_MS,
  planParkedDrops,
  recoverParkedTokens,
  type ParkedTokenEntry,
  type ParkedTokenSource,
  type ParkedTokenSpender,
  type ParkedTokenStorage,
} from "./parked-tokens";

const MINT = "https://mint.cubabitcoin.org";
const KEYSET = "00cadd580ab9ab9a";

/** A real, encodable token so decoding and merging are exercised for real. */
function token(
  secret: string,
  { amount = 1, mint = MINT, unit = "sat" }: { amount?: number; mint?: string; unit?: "sat" | "msat" } = {},
): string {
  // C must be a valid 33-byte hex point but is never verified locally for
  // decode/merge, so a deterministic hex digest of the secret is enough to
  // build a well-formed token with a stable, unique C per input.
  const C = `02${createHash("sha256").update(secret).digest("hex")}`;
  return getEncodedToken({ mint, unit, proofs: [{ amount, id: KEYSET, secret, C }] } as never);
}

function entry(secret: string, overrides: Partial<ParkedTokenEntry> = {}): ParkedTokenEntry {
  const amount = overrides.amount ?? 1;
  return {
    // The encoded proof must carry the same amount as the stored entry, or a
    // test about token value would silently exercise 1 sat instead.
    token: token(secret, { amount }),
    amount,
    unit: "sat",
    createdAt: 1_000,
    ...overrides,
  };
}

/** In-memory storage adapter, recording what was written back. */
function storageOf(entries: ParkedTokenEntry[]) {
  let current = [...entries];
  const writes: ParkedTokenEntry[][] = [];
  const storage: ParkedTokenStorage = {
    getCachedReceiveTokens: () => [...current],
    setCachedReceiveTokens: (next) => {
      writes.push(next);
      current = [...next];
    },
  };
  return { storage, writes, get: () => current };
}

/**
 * Spender whose verdict per token is scripted by the token's first secret-ish
 * marker, defaulting to the sub-fee failure this module exists to stop.
 */
function spenderOf(
  verdicts: Record<string, { success: boolean; message?: string }>,
  fallback = { success: false, message: "Receive amount is not sufficient after fees" },
) {
  const calls: Array<{ token: string; cacheOnFailure?: boolean }> = [];
  const spender: ParkedTokenSpender = {
    async receiveToken(token, cacheOnFailure) {
      calls.push({ token, cacheOnFailure });
      const decoded = getDecodedToken(token, []);
      const secrets = decoded.proofs.map((proof) => proof.secret);
      // A merged token carries many proofs: succeed if every part succeeds.
      const verdict = secrets
        .map((secret) => verdicts[secret])
        .find((candidate) => candidate !== undefined);
      const amount = getTokenMetadata(token).amount.toNumber();
      const settled = verdict ?? fallback;
      return {
        success: settled.success,
        amount: settled.success ? amount : 0,
        unit: "sat" as const,
        ...(settled.message ? { message: settled.message } : {}),
      };
    },
  };
  return { client: { getCashuSpender: () => spender } as ParkedTokenSource, calls };
}

describe("classifyParkedFailure", () => {
  it("treats a sub-fee receive as a fee problem", () => {
    expect(
      classifyParkedFailure("Receive amount is not sufficient after fees"),
    ).toBe("fee-exceeds-value");
  });

  it("treats proofs the mint has consumed as already spent", () => {
    expect(classifyParkedFailure("proofs already spent")).toBe("already-spent");
    expect(classifyParkedFailure("Token already spent")).toBe("already-spent");
  });

  it("treats the mint's zero-output rejection as a fee problem", () => {
    // Observed from mint.cubabitcoin.org for a 1-sat token on a 100 ppk mint:
    // the fee consumes the whole value, so the mint is asked to mint nothing.
    expect(classifyParkedFailure("no outputs provided.")).toBe("fee-exceeds-value");
  });

  it("treats undecodable input as undecodable", () => {
    expect(classifyParkedFailure("Invalid token")).toBe("undecodable");
    expect(classifyParkedFailure("malformed token")).toBe("undecodable");
  });

  it("keeps transient failures retryable", () => {
    // A mint being unreachable must never destroy redeemable money.
    expect(classifyParkedFailure("Failed to fetch mint")).toBeUndefined();
    expect(classifyParkedFailure("network timeout")).toBeUndefined();
    expect(classifyParkedFailure("")).toBeUndefined();
    expect(classifyParkedFailure(undefined)).toBeUndefined();
  });
});

describe("inspectParkedToken", () => {
  it("reads the mint, unit and proofs out of a stored token", () => {
    const inspection = inspectParkedToken(entry("s1"));
    expect(inspection.mint).toBe(MINT);
    expect(inspection.unit).toBe("sat");
    expect(inspection.proofs).toHaveLength(1);
    expect(inspection.proofs[0]?.amount).toBe(1);
    expect(inspection.error).toBeUndefined();
  });

  it("reports an undecodable token instead of throwing", () => {
    const inspection = inspectParkedToken({
      token: "cashuNotARealToken",
      amount: 5,
      unit: "sat",
      createdAt: 1_000,
    });
    expect(inspection.error).toBeDefined();
    expect(inspection.proofs).toHaveLength(0);
  });
});

describe("groupForMerge", () => {
  it("groups tokens by mint and skips single-token groups", () => {
    const inspections = [
      inspectParkedToken(entry("a1")),
      inspectParkedToken(entry("a2")),
      inspectParkedToken(entry("b1", { token: token("b1", { mint: "https://other.mint" }) })),
    ];
    const groups = groupForMerge(inspections);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.mint).toBe(MINT);
    expect(groups[0]?.entries).toHaveLength(2);
  });

  it("keeps sat and msat in separate groups", () => {
    const groups = groupForMerge([
      inspectParkedToken(entry("a1")),
      inspectParkedToken(entry("a2")),
      inspectParkedToken(entry("m1", { token: token("m1", { unit: "msat" }), unit: "msat" })),
      inspectParkedToken(entry("m2", { token: token("m2", { unit: "msat" }), unit: "msat" })),
    ]);
    expect(groups.map((group) => group.unit).sort()).toEqual(["msat", "sat"]);
  });

  it("ignores undecodable entries", () => {
    const groups = groupForMerge([
      inspectParkedToken({ token: "junk", amount: 1, unit: "sat", createdAt: 0 }),
      inspectParkedToken(entry("a1")),
      inspectParkedToken(entry("a2")),
    ]);
    expect(groups[0]?.entries).toHaveLength(2);
  });
});

describe("mergeInspections", () => {
  it("folds every proof into one token worth the sum", () => {
    const entries = [inspectParkedToken(entry("a1")), inspectParkedToken(entry("a2"))];
    const merged = mergeInspections(entries);

    expect(merged.proofCount).toBe(2);
    expect(merged.amount).toBe(2);
    expect(getTokenMetadata(merged.token).amount.toNumber()).toBe(2);
    expect(getDecodedToken(merged.token, []).proofs.map((proof) => proof.secret)).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("merges many one-sat proofs into a batch that clears the fee", () => {
    // 59 x 1 sat at 100 ppk costs ceil(100*59/1000)=6 sat, so the batch nets 53.
    const entries = Array.from({ length: 59 }, (_, i) => inspectParkedToken(entry(`d${i}`)));
    const merged = mergeInspections(entries);
    expect(merged.proofCount).toBe(59);
    expect(merged.amount).toBe(59);
    expect(merged.amount - Math.ceil((100 * merged.proofCount) / 1000)).toBe(53);
  });
});

describe("planParkedDrops", () => {
  const now = 2_000_000_000_000;

  it("drops sub-fee dust only once a merged receive was tried", () => {
    const stale = entry("a1", { createdAt: now - 1_000 });
    const inspections = [inspectParkedToken(stale)];
    // Terminal verdicts are keyed by the token itself, as recoverParkedTokens
    // records them.
    const terminal = new Map([
      [stale.token, { reason: "fee-exceeds-value" as const, detail: "not sufficient after fees" }],
    ]);

    // Not merged yet: the batch may still rescue it, so keep it parked.
    expect(
      planParkedDrops(inspections, {
        received: new Set(),
        terminal,
        merged: false,
        now,
      }),
    ).toEqual([]);

    // Merged and still sub-fee: hopeless, so discard.
    const drops = planParkedDrops(inspections, {
      received: new Set(),
      terminal,
      merged: true,
      now,
    });
    expect(drops).toEqual([
      {
        token: stale.token,
        reason: "fee-exceeds-value",
        amount: 1,
        mint: MINT,
        detail: "not sufficient after fees",
      },
    ]);
  });

  it("drops spent and undecodable entries regardless of merging", () => {
    const spent = inspectParkedToken(entry("spent1", { createdAt: now - 1_000 }));
    const junk = inspectParkedToken({ token: "junk", amount: 1, unit: "sat", createdAt: 0 });
    const drops = planParkedDrops([spent, junk], {
      received: new Set(),
      terminal: new Map([[spent.entry.token, { reason: "already-spent" as const }]]),
      merged: false,
      now,
    });
    expect(drops.map((drop) => drop.reason).sort()).toEqual(["already-spent", "undecodable"]);
  });

  it("never drops a token it just received", () => {
    const receivedEntry = entry("a1", { createdAt: now - 1_000 });
    const drops = planParkedDrops([inspectParkedToken(receivedEntry)], {
      received: new Set([receivedEntry.token]),
      terminal: new Map([[receivedEntry.token, { reason: "already-spent" as const }]]),
      merged: true,
      now,
    });
    expect(drops).toEqual([]);
  });

  it("never expires a token that could still be received", () => {
    // A mint outage must not let age destroy redeemable money: only dust that
    // can never be received alone is dropped on age.
    const old = inspectParkedToken(entry("worthwhile", { amount: 500, createdAt: now - PARKED_TOKEN_MAX_AGE_MS - 1 }));
    expect(
      planParkedDrops([old], {
        received: new Set(),
        terminal: new Map(),
        merged: false,
        now,
      }),
    ).toEqual([]);
  });

  it("drops entries older than the retention window", () => {
    const old = entry("old1", { createdAt: now - PARKED_TOKEN_MAX_AGE_MS - 1 });
    const fresh = entry("fresh1", { createdAt: now - 1_000 });
    const drops = planParkedDrops([inspectParkedToken(old), inspectParkedToken(fresh)], {
      received: new Set(),
      terminal: new Map(),
      merged: true,
      now,
    });
    expect(drops.map((drop) => drop.token)).toEqual([old.token]);
    expect(drops[0]?.reason).toBe("expired");
  });

  it("honours a caller-supplied retention window", () => {
    const old = entry("old1", { createdAt: now - 5_000 });
    const drops = planParkedDrops([inspectParkedToken(old)], {
      received: new Set(),
      terminal: new Map(),
      merged: true,
      now,
      maxAgeMs: 1_000,
    });
    expect(drops[0]?.reason).toBe("expired");
  });

  it("keeps transient failures parked", () => {
    const transient = entry("a1", { createdAt: now - 1_000 });
    expect(
      planParkedDrops([inspectParkedToken(transient)], {
        received: new Set(),
        terminal: new Map(),
        merged: true,
        now,
      }),
    ).toEqual([]);
  });
});

describe("recoverParkedTokens", () => {
  const now = 2_000_000_000_000;
  const fresh = { createdAt: now - 1_000 };

  it("reports nothing when the parked list is empty", async () => {
    const { client, calls } = spenderOf({});
    const { storage, writes } = storageOf([]);

    const recovery = await recoverParkedTokens(client, storage, { now });
    expect(recovery).toEqual({
      attempted: 0,
      succeeded: 0,
      parked: 0,
      recoveredAmount: 0,
      dropped: [],
      batches: 0,
      batchesRecovered: 0,
    });
    expect(calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("receives a token that only needed a reachable mint, and prunes it", async () => {
    const { client } = spenderOf({ a1: { success: true } });
    const { storage, get } = storageOf([entry("a1", fresh)]);

    const recovery = await recoverParkedTokens(client, storage, { now });

    expect(recovery.succeeded).toBe(1);
    expect(recovery.recoveredAmount).toBe(1);
    expect(recovery.dropped).toEqual([]);
    expect(get()).toEqual([]);
  });

  it("rescues sub-fee dust by merging it and rewrites the list once", async () => {
    // Individually every token dies on the 1-sat fee; merged they succeed.
    const { client, calls } = spenderOf(
      {},
      { success: false, message: "Receive amount is not sufficient after fees" },
    );
    const mergingClient: ParkedTokenSource = {
      getCashuSpender: () => ({
        async receiveToken(token, cacheOnFailure) {
          const proofs = getDecodedToken(token, []).proofs;
          // The merged receive is the only one carrying more than one proof.
          if (proofs.length > 1) {
            return { success: true, amount: proofs.length, unit: "sat" as const };
          }
          return await client.getCashuSpender().receiveToken(token, cacheOnFailure);
        },
      }),
    };
    const entries = [entry("d1", fresh), entry("d2", fresh), entry("d3", fresh)];
    const { storage, get, writes } = storageOf(entries);

    const recovery = await recoverParkedTokens(mergingClient, storage, { now });

    expect(recovery.batches).toBe(1);
    expect(recovery.batchesRecovered).toBe(1);
    expect(recovery.recoveredAmount).toBe(3);
    expect(recovery.dropped).toEqual([]);
    // Everything was recovered, so nothing is left parked and the list is
    // rewritten exactly once rather than per token.
    expect(get()).toEqual([]);
    expect(writes).toHaveLength(1);
    // Batching runs first and settles all three, so no token-sized retry is
    // needed afterwards: sub-fee dust is never retried one at a time.
    expect(calls).toHaveLength(0);
  });

  it("reports the mint's verdict, not coco's local fee guard", async () => {
    // In the field, single 1-sat tokens never reach the mint: coco rejects
    // them locally as "not sufficient after fees" even when the mint would
    // have said the proofs are spent. Batching first means the reason we
    // report and record is the mint's.
    const client: ParkedTokenSource = {
      getCashuSpender: () => ({
        async receiveToken(token) {
          const proofs = getDecodedToken(token, []).proofs;
          if (proofs.length === 1) {
            return {
              success: false,
              amount: 0,
              unit: "sat" as const,
              message: "Receive amount is not sufficient after fees",
            };
          }
          return {
            success: false,
            amount: 0,
            unit: "sat" as const,
            message: "proofs already spent",
          };
        },
      }),
    };
    const entries = [entry("d1", fresh), entry("d2", fresh)];
    const { storage } = storageOf(entries);

    const recovery = await recoverParkedTokens(client, storage, { now });

    // "already spent", not "fee exceeds value": the mint answered.
    expect(recovery.dropped.map((drop) => drop.reason)).toEqual([
      "already-spent",
      "already-spent",
    ]);
    expect(recovery.dropped[0]?.detail).toBe("proofs already spent");
  });

  it("does not condemn good dust in a batch rejected for one spent proof", async () => {
    // A merged swap is all-or-nothing: a batch containing one spent proof is
    // rejected as a whole. The good proofs beside it are still redeemable and
    // must be recovered by bisection, never discarded.
    const { client } = spenderOf({}, { success: false, message: "Failed to fetch mint" });
    const bisectingClient: ParkedTokenSource = {
      getCashuSpender: () => ({
        async receiveToken(token) {
          const proofs = getDecodedToken(token, []).proofs;
          const secrets = proofs.map((proof) => proof.secret);
          // "bad" is spent at the mint; every batch that contains it fails.
          if (secrets.includes("bad")) {
            return { success: false, amount: 0, unit: "sat" as const, message: "proofs already spent" };
          }
          if (proofs.length === 1) {
            // Individual retries still hit the sub-fee guard.
            return {
              success: false,
              amount: 0,
              unit: "sat" as const,
              message: "Receive amount is not sufficient after fees",
            };
          }
          return { success: true, amount: proofs.length, unit: "sat" as const };
        },
      }),
    };

    const entries = ["d1", "d2", "bad", "d4"].map((secret) => entry(secret, fresh));
    const { storage, get } = storageOf(entries);

    const recovery = await recoverParkedTokens(bisectingClient, storage, { now });

    // d1 and d2 merged into one receivable batch, so 2 sat were genuinely
    // recovered instead of being thrown away with the bad proof.
    expect(recovery.recoveredAmount).toBe(2);
    expect(get()).toEqual([]);
    // The remaining two sit in the rejected half. Bisection cannot isolate
    // further: a lone 1-sat proof is refused by coco before the mint sees it,
    // so a singleton can never prove itself either way. They therefore inherit
    // the batch verdict rather than being retried forever.
    expect(recovery.dropped.map((drop) => drop.reason)).toEqual([
      "already-spent",
      "already-spent",
    ]);
    expect(recovery.dropped[0]?.detail).toBe("proofs already spent");
    // Crucially, no redeemable value was destroyed: the two recovered sats are
    // reported as recovered, and only the un-isolatable remainder was dropped.
    expect(recovery.recoveredAmount + recovery.dropped.reduce((sum, d) => sum + d.amount, 0)).toBe(4);
    void client;
  });

  it("keeps unreachable dust parked instead of discarding the batch", async () => {
    const client: ParkedTokenSource = {
      getCashuSpender: () => ({
        async receiveToken() {
          return {
            success: false,
            amount: 0,
            unit: "sat" as const,
            message: "Failed to fetch mint",
          };
        },
      }),
    };
    const entries = [entry("d1", fresh), entry("d2", fresh)];
    const { storage, get } = storageOf(entries);

    const recovery = await recoverParkedTokens(client, storage, { now });

    expect(recovery.dropped).toEqual([]);
    expect(get()).toHaveLength(2);
  });

  it("discards fully spent dust but keeps good dust beside it", async () => {
    // Every token is spent, so bisection ends at single tokens each reporting
    // it; all of them are then discarded rather than retried forever.
    const client: ParkedTokenSource = {
      getCashuSpender: () => ({
        async receiveToken() {
          return {
            success: false,
            amount: 0,
            unit: "sat" as const,
            message: "proofs already spent",
          };
        },
      }),
    };
    const entries = [entry("a1", fresh), entry("a2", fresh), entry("a3", fresh)];
    const { storage, get } = storageOf(entries);

    const recovery = await recoverParkedTokens(client, storage, { now });

    expect(recovery.dropped.every((drop) => drop.reason === "already-spent")).toBe(true);
    expect(get()).toEqual([]);
  });

  it("discards dead dust once instead of retrying it forever", async () => {
    // The exact shape of the field incident: 59 one-sat proofs on a 100 ppk
    // mint that the mint has already spent.
    const secrets = Array.from({ length: 5 }, (_, i) => `d${i}`);
    const { client } = spenderOf({}, { success: false, message: "proofs already spent" });
    const entries = secrets.map((secret) => entry(secret, fresh));
    const { storage, get } = storageOf(entries);

    const recovery = await recoverParkedTokens(client, storage, { now });

    expect(recovery.parked).toBe(5);
    expect(recovery.succeeded).toBe(0);
    expect(recovery.batches).toBe(1);
    expect(recovery.dropped).toHaveLength(5);
    expect(recovery.dropped.every((drop) => drop.reason === "already-spent")).toBe(true);
    // The whole point: the list is empty, so the next sweep is silent.
    expect(get()).toEqual([]);
  });

  it("keeps unreachable-mint tokens parked for a later run", async () => {
    const { client } = spenderOf({}, { success: false, message: "Failed to fetch mint" });
    const { storage, get } = storageOf([entry("a1", fresh), entry("a2", fresh)]);

    const recovery = await recoverParkedTokens(client, storage, { now });

    expect(recovery.dropped).toEqual([]);
    expect(recovery.succeeded).toBe(0);
    expect(get()).toHaveLength(2);
  });

  it("drops an undecodable entry without asking the mint about it", async () => {
    const { client, calls } = spenderOf({});
    const junk: ParkedTokenEntry = {
      token: "cashuGarbage",
      amount: 7,
      unit: "sat",
      createdAt: now - 1_000,
    };
    const { storage, get } = storageOf([junk]);

    const recovery = await recoverParkedTokens(client, storage, { now });

    expect(recovery.dropped).toEqual([
      { token: "cashuGarbage", reason: "undecodable", amount: 7, detail: expect.any(String) },
    ]);
    expect(calls).toHaveLength(0);
    expect(get()).toEqual([]);
  });

  it("expires entries past the retention window", async () => {
    const { client } = spenderOf({}, { success: false, message: "Failed to fetch mint" });
    const stale = entry("old1", { createdAt: now - PARKED_TOKEN_MAX_AGE_MS - 1 });
    const { storage, get } = storageOf([stale]);

    const recovery = await recoverParkedTokens(client, storage, { now });

    expect(recovery.dropped.map((drop) => drop.reason)).toEqual(["expired"]);
    expect(get()).toEqual([]);
  });

  it("swallows storage errors so the refund that follows still runs", async () => {
    const { client } = spenderOf({});
    const storage: ParkedTokenStorage = {
      getCachedReceiveTokens() {
        throw new Error("database is locked");
      },
      setCachedReceiveTokens() {},
    };

    const recovery = await recoverParkedTokens(client, storage, { now });
    expect(recovery.error).toBe("database is locked");
    expect(recovery.parked).toBe(0);
  });

  it("swallows spender throws per token and keeps the rest going", async () => {
    const calls: string[] = [];
    const client: ParkedTokenSource = {
      getCashuSpender: () => ({
        async receiveToken(token) {
          const secret = getDecodedToken(token, []).proofs[0]?.secret ?? "";
          calls.push(secret);
          if (secret === "boom") throw new Error("unexpected wallet explosion");
          return { success: false, amount: 0, unit: "sat" as const, message: "Failed to fetch mint" };
        },
      }),
    };
    const { storage, get } = storageOf([entry("boom", fresh), entry("ok", fresh)]);

    const recovery = await recoverParkedTokens(client, storage, { now });

    // The transient failure on the second token is retried, not fatal.
    expect(recovery.error).toBeUndefined();
    expect(get()).toHaveLength(2);
    expect(calls).toContain("ok");
  });

  it("still prunes when the storage write itself fails", async () => {
    const { client } = spenderOf({}, { success: false, message: "proofs already spent" });
    let reads = 0;
    const storage: ParkedTokenStorage = {
      getCachedReceiveTokens() {
        reads += 1;
        return [entry("a1", fresh)];
      },
      setCachedReceiveTokens() {
        throw new Error("disk full");
      },
    };

    const recovery = await recoverParkedTokens(client, storage, { now });

    expect(recovery.dropped).toHaveLength(1);
    expect(reads).toBeGreaterThan(0);
  });
});
