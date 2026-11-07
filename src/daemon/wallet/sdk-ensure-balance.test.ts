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
  return { wallet, sendToken, storage, discovery, manager, client };
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

const ensure = (overrides: Record<string, unknown> = {}) => ({ mintUrl, baseUrl, token: "key",
  requiredSats: 5, targetSats: 7, minimumDeposit: 7, minimumFraction: 0.21, ...overrides });

function balance(amount: number, extra = {}) {
  return { amount, reserved: 500, unit: "sat" as const, apiKey: "key", readSeq: 1, ...extra };
}

describe("automatic ensure-balance funding", () => {
  it("rechecks stale deficits across per-request clients through deposit settlement", async () => {
    const ctx = await setup(); let available = 0;
    const entered = gate(), release = gate(); const deposits: number[] = [];
    const managers = Array.from({ length: 20 }, () => ctx.manager());
    for (const manager of managers) {
      vi.spyOn(manager, "getTokenBalance").mockImplementation(async () => balance(available));
      vi.spyOn(manager as any, "_postTopUp").mockImplementation(async () => {
        entered.release(); await release.promise; available += 7; return { success: true };
      });
    }
    ctx.sendToken.mockImplementation(async (_mint, amount) => { deposits.push(amount); return "cashu_test"; });
    const first = managers[0]!.ensureBalance(ensure()); await entered.promise;
    const rest = managers.slice(1).map(manager => manager.ensureBalance(ensure()));
    expect(deposits).toEqual([7]); release.release();
    await Promise.all([first, ...rest]);
    expect(deposits).toEqual([7]);
    expect(managers.reduce((n, m) => n + (m.getTokenBalance as any).mock.calls.length, 0)).toBe(20);
  });

  it("routes automatic stale snapshots from separate clients through the shared coordinator", async () => {
    const ctx = await setup(); let available = 0;
    const clients = Array.from({ length: 12 }, () => new RoutstrClient(ctx.wallet, ctx.storage,
      ctx.discovery, "min", "apikeys", { logger: noopLogger }));
    const entered = gate(), release = gate();
    for (const client of clients) {
      vi.spyOn(client.getBalanceManager(), "getTokenBalance").mockImplementation(async () => balance(available));
      vi.spyOn(client.getBalanceManager() as any, "_postTopUp").mockImplementation(async () => {
        entered.release(); await release.promise; available += 7; return { success: true };
      });
    }
    const snapshot = { token: "key", baseUrl, mintUrl, requiredSats: 5, tokenBalance: 0,
      tokenBalanceUnit: "sat", tokenBalanceUnknown: false };
    const first = (clients[0] as any)._topUpIfNeeded(snapshot); await entered.promise;
    const rest = clients.slice(1).map(client => (client as any)._topUpIfNeeded(snapshot));
    release.release(); await Promise.all([first, ...rest]);
    expect(ctx.sendToken.mock.calls.map(call => call[1])).toEqual([7]);
    const newcomer = new RoutstrClient(ctx.wallet, ctx.storage, ctx.discovery, "min", "apikeys", { logger: noopLogger });
    vi.spyOn(newcomer.getBalanceManager(), "getTokenBalance").mockImplementation(async () => balance(available));
    await (newcomer as any)._topUpIfNeeded(snapshot);
    expect(ctx.sendToken).toHaveBeenCalledTimes(1);
  });

  it("allows fresh funding when later reservations really drain available balance", async () => {
    const ctx = await setup(); const manager = ctx.manager(); let available = 0;
    vi.spyOn(manager, "getTokenBalance").mockImplementation(async () => balance(available));
    vi.spyOn(manager as any, "_postTopUp").mockImplementation(async () => { available += 7; return { success: true }; });
    await manager.ensureBalance(ensure());
    available = 0; // provider admitted another request and reserved the credit
    await manager.ensureBalance(ensure());
    expect(ctx.sendToken.mock.calls.map(call => call[1])).toEqual([7, 7]);
  });

  it("does not subtract reservations again or fund an unknown/invalid balance", async () => {
    const ctx = await setup(); const manager = ctx.manager();
    const read = vi.spyOn(manager, "getTokenBalance").mockResolvedValue(balance(7));
    expect(await manager.ensureBalance(ensure())).toMatchObject({ success: true, toppedUpAmount: 0 });
    for (const extra of [{ balanceUnknown: true }, { isInvalidApiKey: true }, { amount: NaN }]) {
      read.mockResolvedValue(balance(0, extra));
      expect(await manager.ensureBalance(ensure())).toMatchObject({ success: false });
    }
    expect(ctx.sendToken).not.toHaveBeenCalled();
  });

  it("calculates the margin and minimum once from a fresh balance", async () => {
    const ctx = await setup(); const manager = ctx.manager();
    vi.spyOn(manager, "getTokenBalance").mockResolvedValue(balance(20));
    vi.spyOn(manager as any, "_postTopUp").mockResolvedValue({ success: true });
    await manager.ensureBalance(ensure({ requiredSats: 100, targetSats: 140 }));
    expect(ctx.sendToken.mock.calls.map(call => call[1])).toEqual([120]);
  });

  it("isolates keys, providers and wallets while another key is settling", async () => {
    const ctx = await setup(), other = await setup();
    const manager = ctx.manager(), otherManager = other.manager();
    const entered = gate(), release = gate();
    vi.spyOn(manager, "getTokenBalance").mockResolvedValue(balance(0));
    vi.spyOn(otherManager, "getTokenBalance").mockResolvedValue(balance(0));
    vi.spyOn(manager as any, "_postTopUp").mockImplementationOnce(async () => {
      entered.release(); await release.promise; return { success: true };
    }).mockResolvedValue({ success: true });
    vi.spyOn(otherManager as any, "_postTopUp").mockResolvedValue({ success: true });
    const pending = manager.ensureBalance(ensure()); await entered.promise;
    await Promise.all([manager.ensureBalance(ensure({ token: "other-key" })),
      manager.ensureBalance(ensure({ baseUrl: "https://other.invalid/" })), otherManager.ensureBalance(ensure())]);
    expect(ctx.sendToken).toHaveBeenCalledTimes(3);
    expect(other.sendToken).toHaveBeenCalledTimes(1);
    release.release(); await pending;
  });

  it("keeps explicit manual deposits additive", async () => {
    const ctx = await setup(); const manager = ctx.manager();
    vi.spyOn(manager as any, "_postTopUp").mockResolvedValue({ success: true });
    await Promise.all([manager.topUp(topup()), manager.topUp(topup())]);
    expect(ctx.sendToken.mock.calls.map(call => call[1])).toEqual([14]);
  });

  it("skips a cancelled queued automatic caller but funds its live successor", async () => {
    const ctx = await setup(); const manager = ctx.manager(); const blocker = await blockedWallet(ctx);
    vi.spyOn(manager, "getTokenBalance").mockResolvedValue(balance(0));
    vi.spyOn(manager as any, "_postTopUp").mockResolvedValue({ success: true });
    const cancelled = new AbortController();
    const first = manager.ensureBalance(ensure({ signal: cancelled.signal }));
    const outcome = first.catch(error => error.name);
    const live = manager.ensureBalance(ensure()); cancelled.abort(); blocker.release(); await blocker.pending;
    expect(await outcome).toBe("AbortError"); await live;
    expect(ctx.sendToken.mock.calls.map(call => call[1])).toEqual([1, 7]);
  });

  it("waits for started financial work after cancellation instead of replacing it", async () => {
    const ctx = await setup(); const manager = ctx.manager(); let available = 0;
    const entered = gate(), release = gate();
    vi.spyOn(manager, "getTokenBalance").mockImplementation(async () => balance(available));
    vi.spyOn(manager as any, "_postTopUp").mockImplementation(async () => {
      entered.release(); await release.promise; available += 7; return { success: true };
    });
    const controller = new AbortController();
    const first = manager.ensureBalance(ensure({ signal: controller.signal })); await entered.promise;
    controller.abort(); const live = ctx.manager();
    vi.spyOn(live, "getTokenBalance").mockImplementation(async () => balance(available));
    const second = live.ensureBalance(ensure());
    expect(ctx.sendToken).toHaveBeenCalledTimes(1); release.release(); await Promise.all([first, second]);
    expect(ctx.sendToken).toHaveBeenCalledTimes(1);
  });
});
