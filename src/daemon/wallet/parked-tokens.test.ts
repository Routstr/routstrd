import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { Amount, getDecodedToken, getEncodedToken, type Proof } from "@cashu/cashu-ts";
import {
  inspectParkedTokens,
  recoverParkedTokens,
  type ParkedTokenEntry,
  type ParkedTokenSpender,
  type ParkedTokenStorage,
} from "./parked-tokens";

const MINT = "https://mint.example";
const OTHER_MINT = "https://other.example";
const KEYSET = "00cadd580ab9ab9a";
const V2_KEYSET = `01${"a".repeat(64)}`;
const DAY = 86_400_000;
const FEE = "Receive amount is not sufficient after fees";
const SPENT = "proofs already spent";

function proof(secret: string, amount = 1, id = KEYSET): Proof {
  return {
    amount: Amount.from(amount), id, secret,
    C: `02${createHash("sha256").update(secret).digest("hex")}`,
  };
}

function entry(
  proofs: string | Proof[],
  { mint = MINT, unit = "sat", createdAt = 1 }: {
    mint?: string;
    unit?: ParkedTokenEntry["unit"];
    createdAt?: number;
  } = {},
): ParkedTokenEntry {
  const inputs = typeof proofs === "string" ? [proof(proofs)] : proofs;
  return {
    token: getEncodedToken({ mint, unit, proofs: inputs }),
    amount: inputs.reduce((total, input) => total + input.amount.toNumber(), 0),
    unit,
    createdAt,
  };
}

function setup(entries: ParkedTokenEntry[], receive: ParkedTokenSpender["receiveToken"]) {
  let parked = [...entries];
  const calls: Array<[string, boolean | undefined]> = [];
  const client = {
    getCashuSpender: () => ({
      receiveToken: (token: string, cache?: boolean) => {
        calls.push([token, cache]);
        return receive(token, cache);
      },
    }),
  };
  const storage: ParkedTokenStorage = {
    getCachedReceiveTokens: () => [...parked],
    setCachedReceiveTokens: (next) => { parked = [...next]; },
  };
  return { client, storage, calls, parked: () => parked };
}

function reject(message: string) {
  return { success: false, amount: 0, unit: "sat" as const, message };
}

function accept() {
  // Face value comes from token inputs independently of what the adapter returns.
  return { success: true, amount: 0, unit: "sat" as const };
}

function secrets(token: string): string[] {
  return getDecodedToken(token, []).proofs.map((input) => input.secret);
}

describe("recoverParkedTokens", () => {
  it("makes no wallet or storage writes for an empty list", async () => {
    const { client, storage, calls } = setup([], async () => accept());
    expect(await recoverParkedTokens(client, storage)).toEqual({
      attempted: 0, succeeded: 0, parked: 0, remaining: 0, dropped: [],
      batches: 0, batchesRecovered: 0, recoveredFaceValue: { sat: 0, msat: 0 },
    });
    expect(calls).toHaveLength(0);
  });

  it("redeems same-mint dust in a batch and accounts for denominations separately", async () => {
    const { client, storage, calls, parked } = setup([
      entry("a"), entry("b"), entry([proof("c", 1500)], { unit: "msat" }),
    ], async () => accept());
    const result = await recoverParkedTokens(client, storage);
    expect(calls.map(([token]) => secrets(token))).toEqual([["a", "b"], ["c"]]);
    expect(calls.every(([, cache]) => cache === false)).toBe(true);
    expect(result).toMatchObject({
      attempted: 1, succeeded: 3, parked: 3, remaining: 0,
      recoveredFaceValue: { sat: 2, msat: 1500 }, batches: 1, batchesRecovered: 1,
    });
    expect(parked()).toEqual([]);
  });

  it("preserves DLEQ, P2BK key and witness fields when merging", async () => {
    const special: Proof = {
      ...proof("a"),
      dleq: { e: "11".repeat(32), s: "22".repeat(32), r: "33".repeat(32) },
      p2pk_e: `02${"44".repeat(32)}`,
      witness: { signatures: ["55".repeat(64)] },
    };
    const original = entry([special]);
    const { client, storage, calls } = setup([original, entry("b")], async () => accept());
    await recoverParkedTokens(client, storage);
    expect(calls).toHaveLength(1);
    const merged = getDecodedToken(calls[0]![0], []).proofs[0];
    const decodedOriginal = getDecodedToken(original.token, []).proofs[0];
    expect(merged).toMatchObject({
      id: special.id, secret: special.secret, C: special.C,
      dleq: special.dleq, p2pk_e: special.p2pk_e, witness: decodedOriginal?.witness,
    });
  });

  it("passes a valid v4 token requiring full keyset IDs to the wallet unchanged", async () => {
    const short = entry([proof("short-keyset", 2, V2_KEYSET)]);
    expect(() => getDecodedToken(short.token, [])).toThrow();
    expect(getDecodedToken(short.token, [V2_KEYSET]).proofs[0]?.id).toBe(V2_KEYSET);
    const { client, storage, calls, parked } = setup([short], async () => accept());
    expect(inspectParkedTokens(storage)).toEqual([expect.objectContaining({
      mint: MINT, amount: 2, proofCount: 1,
    })]);
    const result = await recoverParkedTokens(client, storage);
    expect(calls).toEqual([[short.token, false]]);
    expect(result.succeeded).toBe(1);
    expect(result.dropped).toEqual([]);
    expect(parked()).toEqual([]);
  });

  it("keeps all spent-looking dust when no proof states can be confirmed", async () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    for (const checkSpent of [undefined, async () => { throw new Error("checkstate timeout"); }]) {
      const { client, storage, calls, parked } = setup(entries, async () => reject(SPENT));
      const result = await recoverParkedTokens(client, storage, { checkSpent });
      expect(calls).toHaveLength(1);
      expect(result.dropped).toEqual([]);
      expect(parked()).toEqual(entries);
    }
  });

  it("prunes a fully spent batch only after checking every proof", async () => {
    const entries = Array.from({ length: 59 }, (_, i) => entry(`dust-${i}`));
    const { client, storage, calls, parked } = setup(entries, async () => reject(SPENT));
    const result = await recoverParkedTokens(client, storage, {
      checkSpent: async (mint, proofs) => {
        expect(mint).toBe(MINT);
        expect(proofs).toHaveLength(59);
        expect(proofs[0]).toEqual({ id: KEYSET, secret: "dust-0" });
        return new Set(proofs.map(({ secret }) => secret));
      },
    });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ attempted: 0, batches: 1, remaining: 0 });
    expect(result.dropped).toEqual(entries.map(() => ({
      reason: "already-spent", amount: 1, unit: "sat", mint: MINT,
    })));
    expect(parked()).toEqual([]);
  });

  it("re-batches interleaved unspent proofs instead of inheriting the batch verdict", async () => {
    const { client, storage, calls, parked } = setup([
      entry("spentA"), entry("goodA"), entry("spentB"), entry("goodB"),
    ], async (token) => secrets(token).some((secret) => secret.startsWith("spent")) ? reject(SPENT) : accept());
    const result = await recoverParkedTokens(client, storage, {
      checkSpent: async () => new Set(["spentA", "spentB"]),
    });
    expect(calls.map(([token]) => secrets(token))).toEqual([
      ["spentA", "goodA", "spentB", "goodB"], ["goodA", "goodB"],
    ]);
    expect(result).toMatchObject({ succeeded: 2, batches: 2, batchesRecovered: 1 });
    expect(result.dropped).toHaveLength(2);
    expect(parked()).toEqual([]);
  });

  it("retains the original token of a partially spent multi-proof entry", async () => {
    const partiallySpent = entry([proof("spent"), proof("good")]);
    const { client, storage, parked } = setup([partiallySpent], async () => reject(SPENT));
    const result = await recoverParkedTokens(client, storage, {
      checkSpent: async () => new Set(["spent"]),
    });
    expect(result.dropped).toEqual([]);
    expect(parked()).toEqual([partiallySpent]);
  });

  it("discards an original single proof directly reported spent, but not an unknown keyset", async () => {
    const unknown = entry([proof("unknown", 2)], { mint: OTHER_MINT });
    const { client, storage, parked } = setup([entry("spent"), unknown], async (token) =>
      token === unknown.token ? reject("keyset was not found") : reject(SPENT),
    );
    const result = await recoverParkedTokens(client, storage);
    expect(result.dropped).toEqual([{ reason: "already-spent", amount: 1, unit: "sat", mint: MINT }]);
    expect(parked()).toEqual([unknown]);
  });

  it("retains fee-limited old tokens even when another mint attempted a batch", async () => {
    const old = entry("old", { mint: OTHER_MINT, createdAt: Date.now() - 60 * DAY });
    const { client, storage, parked } = setup([entry("a"), entry("b"), old], async (token) =>
      token === old.token ? reject(FEE) : accept(),
    );
    const result = await recoverParkedTokens(client, storage);
    expect(result).toMatchObject({ batches: 1, dropped: [], remaining: 1 });
    expect(parked()).toEqual([old]);
  });

  it("does not fan out for an unreachable mint but still processes other mints", async () => {
    const down = Array.from({ length: 128 }, (_, i) => entry(`dust-${i}`, { createdAt: Date.now() - 60 * DAY }));
    const sameMint = entry([proof("same-mint", 5)]);
    const otherMint = entry([proof("other-mint", 7)], { mint: OTHER_MINT });
    const { client, storage, calls, parked } = setup([...down, sameMint, otherMint], async (token) =>
      token === otherMint.token ? accept() : reject("Failed to fetch mint"),
    );
    const result = await recoverParkedTokens(client, storage);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ attempted: 1, succeeded: 1, batches: 1, dropped: [] });
    expect(parked()).toEqual([...down, sameMint]);
  });

  it("does not split or individually retry a batch after an unknown failure", async () => {
    const entries = [entry("a"), entry("b")];
    const { client, storage, calls, parked } = setup(entries, async () => reject("unknown failure"));
    const result = await recoverParkedTokens(client, storage, {
      checkSpent: async () => { throw new Error("unexpected proof check"); },
    });
    expect(calls).toHaveLength(1);
    expect(result.attempted).toBe(0);
    expect(parked()).toEqual(entries);
  });

  it("does not publish token strings in discard metadata or storage errors", async () => {
    const invalid = { ...entry("bad"), token: "private bearer data" };
    const { client, storage } = setup([invalid], async () => accept());
    expect(inspectParkedTokens(storage)[0]).toMatchObject({
      amount: 1, unit: "sat", proofCount: 0, problem: "Token metadata could not be decoded",
    });
    expect(JSON.stringify(inspectParkedTokens(storage))).not.toContain(invalid.token);
    const result = await recoverParkedTokens(client, storage);
    expect(result.dropped).toEqual([{ reason: "undecodable", amount: 1, unit: "sat" }]);
    const failed = await recoverParkedTokens(client, {
      ...storage, getCachedReceiveTokens() { throw new Error(invalid.token); },
    });
    expect(failed.error).toBeDefined();
    expect(JSON.stringify(failed)).not.toContain(invalid.token);
  });

  it("keeps swap counts but does not claim durable removals on flush failure", async () => {
    const valid = entry([proof("valid", 5)]);
    const invalid = { ...entry("bad"), token: "private bearer data" };
    const { client, storage } = setup([valid, invalid], async () => accept());
    let flushCalls = 0;
    const result = await recoverParkedTokens(client, storage, {
      flush: async () => { flushCalls++; throw new Error(invalid.token); },
    });
    expect(flushCalls).toBe(1);
    expect(result).toMatchObject({
      remaining: 2, succeeded: 1, dropped: [], recoveredFaceValue: { sat: 5, msat: 0 },
      pruneError: "Could not persist parked refund token removals",
    });
    expect(JSON.stringify(result)).not.toContain(invalid.token);
  });

  it("shares one sweep across concurrent callers and waits for the prune to flush", async () => {
    const { client, storage, calls } = setup([entry("a"), entry("b")], async () => accept());
    const flushing = Promise.withResolvers<void>();
    const durable = Promise.withResolvers<void>();
    const first = recoverParkedTokens(client, storage, {
      flush: () => { flushing.resolve(); return durable.promise; },
    });
    await flushing.promise;
    const second = recoverParkedTokens(client, storage);
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
    durable.resolve();
    expect(await second).toMatchObject({ succeeded: 2, remaining: 0 });
    expect((await recoverParkedTokens(client, storage)).succeeded).toBe(0);
  });
});
