import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
const restorers: Array<{ mockRestore(): void }> = [];
const vi = { fn: mock, spyOn: ((...args: any[]) => {
  const spy = (spyOn as any)(...args); restorers.push(spy); return spy;
}) as typeof spyOn, restoreAllMocks: () => { for (const spy of restorers.splice(0)) spy.mockRestore(); } };
import { RoutstrClient, BalanceManager, noopLogger } from "@routstr/sdk";
import { createMemoryDriver, createSdkStore, createStorageAdapterFromStore, createDiscoveryAdapterFromStore } from "@routstr/sdk/storage";
import type { WalletAdapter } from "@routstr/sdk/wallet";

const mintUrl = "https://mint.invalid";
const baseUrl = "https://provider.invalid/";
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function setup() {
  const { store, hydrate } = createSdkStore({ driver: createMemoryDriver() });
  await hydrate;
  const storage = createStorageAdapterFromStore(store);
  const discovery = createDiscoveryAdapterFromStore(store);
  const sendToken = vi.fn(async (_mint: string, _amount: number, _key?: string,
    persist?: (token: string) => Promise<void>, _signal?: AbortSignal) => {
    await persist?.("cashu_test");
    return "cashu_test";
  });
  const wallet: WalletAdapter = {
    getBalances: async () => ({ [mintUrl]: 1000 }),
    getMintUnits: () => ({ [mintUrl]: "sat" }),
    getActiveMintUrl: () => mintUrl,
    sendToken,
    receiveToken: async () => ({ success: true, amount: 7, unit: "sat" }),
  };
  const manager = () => new BalanceManager(wallet, storage, discovery, undefined, noopLogger);
  const client = new RoutstrClient(wallet, storage, discovery, "min", "apikeys", { logger: noopLogger });
  return { wallet, sendToken, storage, manager, client };
}
async function blockedWallet(ctx: Awaited<ReturnType<typeof setup>>) {
  const entered = gate();
  const release = gate();
  ctx.sendToken.mockImplementationOnce(async () => {
    entered.release();
    await release.promise;
    return "cashu_blocker";
  });
  const pending = ctx.manager().createProviderToken({ mintUrl, baseUrl, amount: 1 });
  await entered.promise;
  return { release: release.release, pending };
}
const topup = (signal?: AbortSignal, amount = 7) => ({ mintUrl, baseUrl, amount, token: "key", signal });
afterEach(() => vi.restoreAllMocks());

describe("funding cancellation boundaries", () => {
  it("does not fund or dispatch inference when preparation resumes after abort", async () => {
    const ctx = await setup();
    const entered = gate();
    const release = gate();
    const controller = new AbortController();
    vi.spyOn((ctx.client as any).providerManager, "getModelForProvider").mockImplementation(async () => {
      entered.release(); await release.promise;
      return { id: "model", sats_pricing: { prompt: 1, completion: 1, max_cost: 7 } };
    });
    const spend = vi.spyOn((ctx.client as any).cashuSpender, "spend");
    const inference = vi.spyOn(ctx.client as any, "_makeRequest");
    // Retain the inner preparation promise, proving all late work has drained.
    const prepare = (ctx.client as any)._prepareRoutedRequestWithMintFailover.bind(ctx.client);
    let inner!: Promise<unknown>;
    vi.spyOn(ctx.client as any, "_prepareRoutedRequestWithMintFailover").mockImplementation((params: any) => {
      inner = prepare(params); return inner;
    });
    const response = ctx.client.routeRequest({ path: "/v1/chat/completions", method: "POST",
      body: { model: "model" }, modelId: "model", baseUrl, mintUrl,
      signal: controller.signal, trackLifecycle: false });
    await entered.promise;
    controller.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    release.release();
    await inner.catch(() => {});
    expect(spend).not.toHaveBeenCalled();
    expect(ctx.sendToken).not.toHaveBeenCalled();
    expect(inference).not.toHaveBeenCalled();
  });

  it("does not start a provider token send queued behind another wallet send", async () => {
    const ctx = await setup();
    const blocker = await blockedWallet(ctx);
    const controller = new AbortController();
    const pending = ctx.manager().createProviderToken({ mintUrl, baseUrl, amount: 7, signal: controller.signal });
    controller.abort(); blocker.release();
    await blocker.pending;
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.sendToken).toHaveBeenCalledTimes(1);
  });

  it("skips a wholly cancelled queued top-up", async () => {
    const ctx = await setup();
    const blocker = await blockedWallet(ctx);
    const controller = new AbortController();
    const manager = ctx.manager();
    const deposit = vi.spyOn(manager as any, "_postTopUp").mockResolvedValue({ success: true });
    const pending = manager.topUp(topup(controller.signal));
    controller.abort(); blocker.release();
    await blocker.pending;
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.sendToken).toHaveBeenCalledTimes(1);
    expect(deposit).not.toHaveBeenCalled();
  });

  it("drops only cancelled batch contributions and retains a live caller", async () => {
    const ctx = await setup();
    const blocker = await blockedWallet(ctx);
    const controller = new AbortController();
    const first = ctx.manager(); const second = ctx.manager();
    vi.spyOn(first as any, "_postTopUp").mockResolvedValue({ success: true });
    vi.spyOn(second as any, "_postTopUp").mockResolvedValue({ success: true });
    const cancelled = first.topUp(topup(controller.signal, 7));
    const live = second.topUp(topup(undefined, 11));
    controller.abort(); blocker.release();
    await blocker.pending;
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(await live).toMatchObject({ success: true, toppedUpAmount: 11 });
    expect(ctx.sendToken.mock.calls.map((call) => call[1])).toEqual([1, 11]);
  });

  it("recomputes shared contributions when cancellation arrives during balance preparation", async () => {
    const ctx = await setup(); const blocker = await blockedWallet(ctx);
    const controller = new AbortController();
    const entered = gate(); const release = gate();
    const balances = ctx.wallet.getBalances;
    let hold = true;
    ctx.wallet.getBalances = async () => {
      if (hold) { hold = false; entered.release(); await release.promise; }
      return balances();
    };
    const manager = ctx.manager();
    vi.spyOn(manager as any, "_postTopUp").mockResolvedValue({ success: true });
    const cancelled = manager.topUp(topup(controller.signal, 7));
    const live = manager.topUp(topup(undefined, 11));
    blocker.release(); await blocker.pending; await entered.promise;
    controller.abort(); release.release();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(await live).toMatchObject({ success: true, toppedUpAmount: 11 });
    expect(ctx.sendToken.mock.calls.map((call) => call[1])).toEqual([1, 11]);
  });

  it("recomputes shared contributions after a wallet recovery wait without starting the cancelled send", async () => {
    const ctx = await setup(); const blocker = await blockedWallet(ctx);
    const controller = new AbortController(); const entered = gate(); const release = gate();
    // Contract of an adapter with an internal recovery gate: check immediately
    // before prepare. The first call below has not started a financial operation.
    const financialAmounts: number[] = [];
    ctx.sendToken.mockImplementationOnce(async (_mint, amount, _key, persist, signal) => {
      entered.release(); await release.promise;
      signal?.throwIfAborted(); financialAmounts.push(amount);
      await persist?.("cashu_test"); return "cashu_test";
    }).mockImplementation(async (_mint, amount, _key, persist, signal) => {
      signal?.throwIfAborted(); financialAmounts.push(amount);
      await persist?.("cashu_test"); return "cashu_test";
    });
    const manager = ctx.manager();
    vi.spyOn(manager as any, "_postTopUp").mockResolvedValue({ success: true });
    const cancelled = manager.topUp(topup(controller.signal, 7));
    const live = manager.topUp(topup(undefined, 11));
    blocker.release(); await blocker.pending; await entered.promise;
    controller.abort(); release.release();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(await live).toMatchObject({ success: true, toppedUpAmount: 11 });
    expect(financialAmounts).toEqual([11]);
  });

  it("keeps a shared client top-up alive when its first caller cancels", async () => {
    const ctx = await setup();
    const blocker = await blockedWallet(ctx);
    const manager = (ctx.client as any).balanceManager;
    vi.spyOn(manager, "_postTopUp").mockResolvedValue({ success: true });
    const cancelled = new AbortController(); const live = new AbortController();
    const start = (signal: AbortSignal) => manager.topUp(topup(signal));
    const first = (ctx.client as any)._topUpOnce("key", start, cancelled.signal);
    const second = (ctx.client as any)._topUpOnce("key", start, live.signal);
    cancelled.abort(); blocker.release();
    await blocker.pending;
    expect(await first).toMatchObject({ success: true });
    expect(await second).toMatchObject({ success: true });
    expect(ctx.sendToken.mock.calls.map((call) => call[1])).toEqual([1, 7]);
  });

  it("settles and persists a send already underway despite cancellation", async () => {
    const ctx = await setup();
    const entered = gate(); const release = gate(); const controller = new AbortController();
    ctx.sendToken.mockImplementationOnce(async (_mint, _amount, _key, persist) => {
      entered.release(); await release.promise; await persist?.("cashu_inflight"); return "cashu_inflight";
    });
    const manager = ctx.manager();
    const deposit = vi.spyOn(manager as any, "_postTopUp").mockImplementation(async () => {
      expect(ctx.storage.getXcashuTokensForBaseUrl(baseUrl).map((entry) => entry.token)).toContain("cashu_inflight");
      return { success: true };
    });
    const pending = manager.topUp(topup(controller.signal));
    await entered.promise; controller.abort(); release.release();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(deposit).toHaveBeenCalledTimes(1);
    expect(ctx.storage.getXcashuTokensForBaseUrl(baseUrl)).toEqual([]);
  });

  it("does not retry an in-flight non-cancellation send failure for a surviving caller", async () => {
    const ctx = await setup(); const blocker = await blockedWallet(ctx);
    const entered = gate(); const release = gate(); const controller = new AbortController();
    ctx.sendToken.mockImplementationOnce(async () => {
      entered.release(); await release.promise; throw new Error("financial outcome unknown");
    });
    const manager = ctx.manager();
    const deposit = vi.spyOn(manager as any, "_postTopUp").mockResolvedValue({ success: true });
    const cancelled = manager.topUp(topup(controller.signal));
    const live = manager.topUp(topup(undefined, 11));
    blocker.release(); await blocker.pending; await entered.promise;
    controller.abort(); release.release();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(await live).toMatchObject({ success: false, message: "financial outcome unknown" });
    expect(ctx.sendToken).toHaveBeenCalledTimes(2); // blocker and failed financial work only
    expect(deposit).not.toHaveBeenCalled();
  });

  it("allows normal funding and inference", async () => {
    const ctx = await setup();
    vi.spyOn((ctx.client as any).providerManager, "getModelForProvider").mockResolvedValue({
      id: "model", sats_pricing: { prompt: 1, completion: 1, max_cost: 7 },
    });
    vi.spyOn((ctx.client as any).balanceManager, "getTokenBalance").mockResolvedValue({ amount: 100, reserved: 0, unit: "sat" });
    const inference = vi.spyOn(ctx.client as any, "_makeRequest").mockResolvedValue(new Response("{}", { headers: { "content-type": "application/json" } }));
    const response = await ctx.client.routeRequest({ path: "/v1/chat/completions", method: "POST",
      body: { model: "model" }, modelId: "model", baseUrl, mintUrl, trackLifecycle: false });
    expect(response.status).toBe(200);
    expect(ctx.sendToken).toHaveBeenCalledTimes(1);
    expect(inference).toHaveBeenCalledTimes(1);
    await response.finalize?.();
  });
});
