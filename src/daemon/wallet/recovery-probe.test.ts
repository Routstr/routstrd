import { describe, expect, it, mock } from "bun:test";
import {
  collectStuckOperations,
  probeMintReachability,
  runTargetedRecovery,
  startRecoveryRecheck,
  type StuckOperationSource,
  type SendRecoveryService,
} from "./recovery-probe";

interface FakeOp {
  id: string;
  mintUrl: string;
  state: string;
}

function op(id: string, mintUrl: string, state = "pending"): FakeOp {
  return { id, mintUrl, state };
}

interface FakeSource extends StuckOperationSource {
  stuck: Record<"send" | "melt" | "receive" | "mint", FakeOp[]>;
  refreshed: Record<"send" | "melt" | "receive" | "mint", string[]>;
  failOnRefresh?: Set<string>;
}

function makeSource(
  stuck: Partial<Record<"send" | "melt" | "receive" | "mint", FakeOp[]>>,
): FakeSource {
  const refreshed: FakeSource["refreshed"] = {
    send: [],
    melt: [],
    receive: [],
    mint: [],
  };
  const full = {
    send: stuck.send ?? [],
    melt: stuck.melt ?? [],
    receive: stuck.receive ?? [],
    mint: stuck.mint ?? [],
  };
  const family = (kind: keyof typeof full) => ({
    listInFlight: async () => full[kind] as never,
    refresh: async (id: string) => {
      refreshed[kind].push(id);
      if (full[kind].some((o) => o.id === id && o.id.startsWith("boom"))) {
        throw new Error("mint rejected the operation");
      }
      return full[kind].find((o) => o.id === id) as never;
    },
  });
  return {
    stuck: full,
    refreshed,
    send: family("send") as FakeSource["send"],
    melt: family("melt") as FakeSource["melt"],
    receive: family("receive") as FakeSource["receive"],
    mint: family("mint") as FakeSource["mint"],
  };
}

function makeSendService(): SendRecoveryService & {
  initRecovered: string[];
  executingRecovered: string[];
} {
  const initRecovered: string[] = [];
  const executingRecovered: string[] = [];
  return {
    initRecovered,
    executingRecovered,
    tryRecoverInitOperation: async (raw) => {
      initRecovered.push((raw as FakeOp).id);
    },
    tryRecoverExecutingOperation: async (raw) => {
      executingRecovered.push((raw as FakeOp).id);
    },
  };
}

/** fetch stub: mints whose URL contains "dead" hang/fail; others answer. */
function makeFetch(deadPredicate: (url: string) => boolean) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const href = String(url);
    calls.push(href);
    if (deadPredicate(href)) throw new Error("connect ECONNREFUSED");
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const isDeadUrl = (url: string) => url.includes("dead");

const liveFetch = () => makeFetch(() => false);

describe("collectStuckOperations", () => {
  it("aggregates all four operation families with normalized mint URLs", async () => {
    const source = makeSource({
      send: [op("s1", "https://mint.example.com/")],
      melt: [op("m1", "https://mint.example.com")],
      receive: [op("r1", "https://other.example.com", "executing")],
      mint: [op("q1", "https://mint.example.com")],
    });
    const stuck = await collectStuckOperations(source);
    expect(stuck).toHaveLength(4);
    expect(stuck.map((s) => s.kind).sort()).toEqual([
      "melt",
      "mint",
      "receive",
      "send",
    ]);
    // Trailing slash normalized so the same mint dedupes to one probe target.
    const mintUrls = new Set(stuck.map((s) => s.mintUrl));
    expect(mintUrls.size).toBe(2);
  });

  it("returns empty when nothing is stuck", async () => {
    const stuck = await collectStuckOperations(makeSource({}));
    expect(stuck).toEqual([]);
  });
});

describe("probeMintReachability", () => {
  it("marks only mints whose fetch fails as unreachable", async () => {
    const deadFetch = makeFetch(isDeadUrl);
    const unreachable = await probeMintReachability(
      ["https://live.example.com", "https://dead.example.com"],
      { fetchImpl: deadFetch.fetchImpl },
    );
    expect([...unreachable]).toEqual(["https://dead.example.com"]);
    expect(deadFetch.calls).toHaveLength(2);
    expect(deadFetch.calls.every((c) => c.endsWith("/v1/info"))).toBe(true);
  });

  it("treats HTTP error responses as reachable", async () => {
    const fetchImpl = (async () =>
      new Response("oops", { status: 500 })) as unknown as typeof fetch;
    const unreachable = await probeMintReachability(["https://live.example.com"], {
      fetchImpl,
    });
    expect(unreachable.size).toBe(0);
  });
});

describe("runTargetedRecovery", () => {
  it("does not probe when nothing is stuck", async () => {
    const deadFetch = makeFetch(isDeadUrl);
    const result = await runTargetedRecovery(makeSource({}), makeSendService(), {
      fetchImpl: deadFetch.fetchImpl,
    });
    expect(result).toMatchObject({ recovered: 0, skipped: 0, failed: 0 });
    expect(deadFetch.calls).toHaveLength(0);
  });

  it("skips operations at unreachable mints and recovers the rest", async () => {
    const source = makeSource({
      send: [op("s1", "https://dead.example.com"), op("s2", "https://live.example.com")],
      melt: [op("m1", "https://dead.example.com"), op("m2", "https://live.example.com")],
    });
    const deadFetch = makeFetch(isDeadUrl);
    const skippedMints: Array<[string, number]> = [];
    const result = await runTargetedRecovery(source, makeSendService(), {
      fetchImpl: deadFetch.fetchImpl,
      onSkippedMint: (mintUrl, count) => skippedMints.push([mintUrl, count]),
    });
    expect(result.recovered).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.failed).toBe(0);
    expect(skippedMints).toEqual([["https://dead.example.com", 2]]);
    expect(result.skippedMints.get("https://dead.example.com")).toBe(2);
    // Only live-mint operations were driven.
    expect(source.refreshed.send).toEqual(["s2"]);
    expect(source.refreshed.melt).toEqual(["m2"]);
  });

  it("recovers pending sends via refresh and executing sends via the service", async () => {
    const source = makeSource({
      send: [
        op("pending-1", "https://live.example.com", "pending"),
        op("exec-1", "https://live.example.com", "executing"),
        op("init-1", "https://live.example.com", "init"),
      ],
    });
    const sendService = makeSendService();
    const result = await runTargetedRecovery(source, sendService, {
      fetchImpl: liveFetch().fetchImpl,
    });
    expect(result.recovered).toBe(3);
    expect(source.refreshed.send).toEqual(["pending-1"]);
    expect(sendService.executingRecovered).toEqual(["exec-1"]);
    expect(sendService.initRecovered).toEqual(["init-1"]);
  });

  it("counts per-operation failures at reachable mints and continues", async () => {
    const source = makeSource({
      melt: [op("boom-1", "https://live.example.com"), op("m2", "https://live.example.com")],
    });
    const result = await runTargetedRecovery(source, makeSendService(), {
      fetchImpl: liveFetch().fetchImpl,
    });
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(1);
    expect(source.refreshed.melt).toEqual(["boom-1", "m2"]);
  });

  it("respects the kinds filter and a pre-computed unreachable set", async () => {
    const deadFetch = makeFetch(isDeadUrl);
    const source = makeSource({
      send: [op("s1", "https://dead.example.com")],
      mint: [op("q1", "https://dead.example.com")],
    });
    const result = await runTargetedRecovery(source, makeSendService(), {
      kinds: ["mint"],
      unreachableMints: new Set(["https://dead.example.com"]),
      fetchImpl: deadFetch.fetchImpl,
    });
    // No probe ran (pre-computed set) and the send op was not even counted.
    expect(deadFetch.calls).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(source.refreshed.send).toEqual([]);
  });
});

describe("startRecoveryRecheck", () => {
  it("recovers stuck operations on the interval and stops cleanly", async () => {
    const source = makeSource({
      send: [op("s1", "https://live.example.com")],
    });
    const stop = startRecoveryRecheck(source, makeSendService(), {
      intervalMs: 20,
      fetchImpl: liveFetch().fetchImpl,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await stop();
    expect(source.refreshed.send.length).toBeGreaterThanOrEqual(1);
    const after = source.refreshed.send.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(source.refreshed.send.length).toBe(after);
  });

  it("is idle without network traffic when nothing is stuck", async () => {
    const { calls, fetchImpl } = makeFetch(() => false);
    const stop = startRecoveryRecheck(makeSource({}), makeSendService(), {
      intervalMs: 20,
      fetchImpl,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await stop();
    expect(calls).toHaveLength(0);
  });

  it("reports mint down/up transitions once instead of repeating", async () => {
    let dead = true;
    const { fetchImpl } = makeFetch(() => dead);
    const source = makeSource({
      melt: [op("m1", "https://flaky.example.com")],
    });
    const down: string[] = [];
    const back: string[] = [];
    const stop = startRecoveryRecheck(source, makeSendService(), {
      intervalMs: 20,
      fetchImpl,
      onMintDown: (mintUrl) => down.push(mintUrl),
      onMintBack: (mintUrl) => back.push(mintUrl),
    });
    await new Promise((resolve) => setTimeout(resolve, 90));
    // Dead across several ticks: reported once, never re-probed per op.
    expect(down).toEqual(["https://flaky.example.com"]);
    expect(back).toEqual([]);
    expect(source.refreshed.melt).toEqual([]);

    dead = false;
    await new Promise((resolve) => setTimeout(resolve, 90));
    await stop();
    expect(down).toEqual(["https://flaky.example.com"]);
    expect(back).toEqual(["https://flaky.example.com"]);
    expect(source.refreshed.melt.length).toBeGreaterThanOrEqual(1);
  });
});
