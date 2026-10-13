import { describe, it, expect } from "bun:test";
import type { SdkStore } from "@routstr/sdk";
import { createModelService } from "./models";

/**
 * `ensureProvidersBootstrapped` must mirror discovery into the SdkStore:
 *
 * - the review-disabled provider set (kind 38425), because `providers list`
 *   and the per-model provider views read the store, so without this a fresh
 *   install reports "0 disabled" while routing silently excludes them;
 * - the discovered base URL list, because the CLI lists providers from the
 *   store. It is replaced rather than merged, so a shrinking discovery result
 *   cannot leave URLs visible that routing no longer uses.
 */
describe("createModelService.ensureProvidersBootstrapped", () => {
  function makeStore(initialBaseUrls: string[] = []) {
    const disabledCalls: string[][] = [];
    const baseUrlCalls: string[][] = [];
    const state: Record<string, unknown> = {
      baseUrlsList: initialBaseUrls,
      setBaseUrlsList: (urls: string[]) => {
        state.baseUrlsList = urls;
        baseUrlCalls.push(urls);
      },
      disabledProviders: [],
      setDisabledProviders: (urls: string[]) => {
        state.disabledProviders = urls;
        disabledCalls.push(urls);
      },
      manuallyDisabledProviders: [],
      manuallyEnabledProviders: [],
    };

    return {
      store: { getState: () => state } as unknown as SdkStore,
      state,
      baseUrlCalls,
      disabledCalls,
    };
  }

  function makeModelManager(
    providers: string[],
    reviewedDisabled: string[] | null,
  ) {
    return {
      bootstrapProviders: async () => providers,
      syncReviewedProvidersFromNostr: async () => reviewedDisabled,
    } as never;
  }

  it("mirrors review-disabled providers into the store after bootstrap", async () => {
    const { store, state, disabledCalls } = makeStore();
    const modelManager = makeModelManager(
      ["https://ok.example/", "https://bad.example/"],
      ["https://bad.example/"],
    );
    const service = createModelService(
      modelManager as never,
      {} as never,
      store,
    );

    await service.ensureProvidersBootstrapped();

    expect(disabledCalls).toEqual([["https://bad.example/"]]);
    expect(state.disabledProviders).toEqual(["https://bad.example/"]);
  });

  it("leaves the store unchanged when review sync reports no change (null)", async () => {
    const { store, state, disabledCalls } = makeStore(["https://ok.example/"]);
    const modelManager = makeModelManager(
      ["https://ok.example/", "https://new.example/"],
      null,
    );
    const service = createModelService(
      modelManager as never,
      {} as never,
      store,
    );

    await service.ensureProvidersBootstrapped();

    expect(disabledCalls).toEqual([]);
    expect(state.disabledProviders).toEqual([]);
  });

  it("adds discovered providers to the store list", async () => {
    const { store, state, baseUrlCalls } = makeStore(["https://ok.example/"]);
    const modelManager = makeModelManager(
      ["https://ok.example/", "https://new.example/"],
      null,
    );
    const service = createModelService(
      modelManager as never,
      {} as never,
      store,
    );

    await service.ensureProvidersBootstrapped();

    expect(baseUrlCalls).toEqual([
      ["https://ok.example/", "https://new.example/"],
    ]);
    expect(state.baseUrlsList).toEqual([
      "https://ok.example/",
      "https://new.example/",
    ]);
  });

  it("replaces a stale store list instead of merging into it", async () => {
    // A bootstrap regression (or a provider unpublishing) shrinking the
    // discovered set must not leave the dropped URLs in `providers list`.
    const { store, state, baseUrlCalls } = makeStore([
      "https://gone.example/",
      "https://stale.example/",
      "https://ok.example/",
    ]);
    const modelManager = makeModelManager(["https://ok.example/"], []);
    const service = createModelService(
      modelManager as never,
      {} as never,
      store,
    );

    await service.ensureProvidersBootstrapped();

    expect(baseUrlCalls).toEqual([["https://ok.example/"]]);
    expect(state.baseUrlsList).toEqual(["https://ok.example/"]);
  });

  it("does not rewrite the store list when discovery already matches", async () => {
    const { store, baseUrlCalls } = makeStore([
      "https://a.example/",
      "https://b.example/",
    ]);
    const modelManager = makeModelManager(
      ["https://b.example/", "https://a.example/"],
      [],
    );
    const service = createModelService(
      modelManager as never,
      {} as never,
      store,
    );

    await service.ensureProvidersBootstrapped();

    expect(baseUrlCalls).toEqual([]);
  });
});

/**
 * `getRoutstr21Models` must resolve each routstr21 id against the aggregated
 * provider models even when the surviving entry is a provider's raw model
 * under a mapped variant id (e.g. z-ai-glm-5-3-flash for glm-5.3-flash).
 * Those entries carry the full metadata (context_length, architecture,
 * reasoning) but their `.id` is the variant, so a plain id lookup used to
 * miss and degrade the exposed entry to a bare `{ id, name }` stub — which is
 * what integrations (pi's models.json) project as missing context windows.
 */
describe("createModelService.getRoutstr21Models", () => {
  function makeStore() {
    const state: Record<string, unknown> = {
      baseUrlsList: [],
      setBaseUrlsList: () => {},
      disabledProviders: [],
      setDisabledProviders: () => {},
      manuallyDisabledProviders: [],
      manuallyEnabledProviders: [],
    };
    return { getState: () => state } as unknown as SdkStore;
  }

  function makeModelManager(
    routstr21Ids: string[],
    cached: Record<string, unknown[]>,
  ) {
    return {
      fetchRoutstr21Models: async () => routstr21Ids,
      getAllCachedModels: () => cached,
      getBaseUrls: () => Object.keys(cached),
      // Warm reads must stay cache-only; these only run when the cache is
      // empty and should never be reached in these tests.
      bootstrapProviders: async () => {
        throw new Error("unexpected bootstrap");
      },
      syncReviewedProvidersFromNostr: async () => null,
      fetchModels: async () => {
        throw new Error("unexpected fetchModels");
      },
    } as never;
  }

  it("resolves a routstr21 id served only under a mapped variant id, with full metadata", async () => {
    const variant = {
      id: "z-ai-glm-5-3-flash",
      alias_ids: ["glm-5-3-flash", "glm-5.3-flash"],
      name: "GLM 5.3 Flash",
      context_length: 1048576,
      architecture: { input_modalities: ["text", "image"] },
      sats_pricing: { completion: 1 },
    };
    const service = createModelService(
      makeModelManager(["glm-5.3-flash"], { "https://p.example/": [variant] }) as never,
      {} as never,
      makeStore(),
    );

    const models = await service.getRoutstr21Models();

    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("glm-5.3-flash");
    expect(models[0]!.name).toBe("GLM 5.3 Flash");
    expect(models[0]!.context_length).toBe(1048576);
    expect((models[0] as Record<string, unknown>).architecture).toEqual({
      input_modalities: ["text", "image"],
    });
  });

  it("exposes the canonical id when the cheapest entry is a variant of a native model", async () => {
    // Two providers serve the same model; the cheaper one only knows it as
    // z-ai-glm-5-3. Aggregation folds them into one entry (the variant), and
    // the routstr21 id must still resolve to it.
    const native = {
      id: "glm-5.3",
      name: "Z.ai: GLM 5.3",
      context_length: 1310720,
      sats_pricing: { completion: 10 },
    };
    const variant = {
      id: "z-ai-glm-5-3",
      name: "GLM 5.3",
      context_length: 1310720,
      sats_pricing: { completion: 1 },
    };
    const service = createModelService(
      makeModelManager(["glm-5.3"], {
        "https://a.example/": [native],
        "https://b.example/": [variant],
      }) as never,
      {} as never,
      makeStore(),
    );

    const models = await service.getRoutstr21Models();

    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("glm-5.3");
    expect(models[0]!.context_length).toBe(1310720);
  });

  it("keeps full metadata for models served under their native id", async () => {
    const native = {
      id: "kimi-k3",
      name: "Kimi K3",
      context_length: 1000000,
      sats_pricing: { completion: 1 },
    };
    const service = createModelService(
      makeModelManager(["kimi-k3"], { "https://p.example/": [native] }) as never,
      {} as never,
      makeStore(),
    );

    const models = await service.getRoutstr21Models();

    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe("kimi-k3");
    expect(models[0]!.name).toBe("Kimi K3");
    expect(models[0]!.context_length).toBe(1000000);
  });

  it("falls back to a bare stub for models no provider serves", async () => {
    const other = {
      id: "kimi-k3",
      name: "Kimi K3",
      context_length: 1000000,
      sats_pricing: { completion: 1 },
    };
    const service = createModelService(
      makeModelManager(["no-such-model"], { "https://p.example/": [other] }) as never,
      {} as never,
      makeStore(),
    );

    const models = await service.getRoutstr21Models();

    expect(models).toEqual([{ id: "no-such-model", name: "no-such-model" }]);
  });
});

/**
 * Finding #4: the SDK refuses to spend a mint a provider does not advertise,
 * so the daemon must actually populate the mint cache during bootstrap (and
 * refresh). `discoverMints` was previously never called, leaving
 * `getCachedMints()` empty and every provider "accepting all mints".
 */
describe("createModelService mint discovery wiring", () => {
  function makeStore() {
    const state: Record<string, unknown> = {
      baseUrlsList: [],
      setBaseUrlsList: () => {},
      disabledProviders: [],
      setDisabledProviders: () => {},
      manuallyDisabledProviders: [],
      manuallyEnabledProviders: [],
    };
    return { store: { getState: () => state } as unknown as SdkStore };
  }

  it("discovers mints for every bootstrapped provider", async () => {
    const providers = ["https://a.example/", "https://b.example/"];
    const modelManager = {
      bootstrapProviders: async () => providers,
      syncReviewedProvidersFromNostr: async () => [],
    } as never;
    const discoverCalls: string[][] = [];
    const mintDiscovery = {
      discoverMints: async (urls: string[]) => {
        discoverCalls.push(urls);
        return { mintsFromProviders: {}, infoFromProviders: {} };
      },
    } as never;

    const service = createModelService(
      modelManager as never,
      {} as never,
      makeStore().store,
      mintDiscovery as never,
    );
    await service.ensureProvidersBootstrapped();

    expect(discoverCalls).toEqual([providers]);
  });

  it("does not fail bootstrap when mint discovery throws", async () => {
    const modelManager = {
      bootstrapProviders: async () => ["https://a.example/"],
      syncReviewedProvidersFromNostr: async () => [],
    } as never;
    const mintDiscovery = {
      discoverMints: async () => {
        throw new Error("mint discovery boom");
      },
    } as never;

    const service = createModelService(
      modelManager as never,
      {} as never,
      makeStore().store,
      mintDiscovery as never,
    );

    await expect(service.ensureProvidersBootstrapped()).resolves.toBeUndefined();
  });

  it("does not await an outstanding mint discovery pass or duplicate it", async () => {
    let resolveDiscovery!: () => void;
    const pending = new Promise<void>((resolve) => { resolveDiscovery = resolve; });
    let calls = 0;
    const modelManager = {
      bootstrapProviders: async () => ["https://a.example/"],
      syncReviewedProvidersFromNostr: async () => [],
    } as never;
    const discovery = {
      discoverMints: () => { calls++; return pending; },
    } as never;
    const service = createModelService(modelManager, {} as never, makeStore().store, discovery);
    try {
      await Promise.race([
        service.ensureProvidersBootstrapped(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("bootstrap blocked on mint discovery")), 100)),
      ]);
      await service.ensureProvidersBootstrapped();
      expect(calls).toBe(1);
    } finally {
      resolveDiscovery();
    }
  });

});

describe("model population single-flight", () => {
  const provider = "https://p.example/";
  const model = { id: "m", name: "Model", sats_pricing: { completion: 1 } };
  function fixture(ids = ["m"]) {
    let cached: Record<string, typeof model[]> = {};
    const calls: boolean[] = [];
    const idCalls: boolean[] = [];
    let release!: (models: typeof model[]) => void;
    let reject!: (error: Error) => void;
    let gate = new Promise<typeof model[]>((resolve, fail) => { release = resolve; reject = fail; });
    const state = {
      baseUrlsList: [provider], disabledProviders: [],
      manuallyDisabledProviders: [], manuallyEnabledProviders: [],
      setBaseUrlsList: () => {}, setDisabledProviders: () => {},
    };
    const manager = {
      bootstrapProviders: async () => [provider],
      syncReviewedProvidersFromNostr: async () => [],
      getBaseUrls: () => [provider],
      getAllCachedModels: () => cached,
      fetchRoutstr21Models: async (force: boolean) => { idCalls.push(force); return ids; },
      fetchModels: async (_urls: string[], force: boolean) => { calls.push(force); return gate; },
    };
    return {
      service: createModelService(manager as never, {} as never, { getState: () => state } as unknown as SdkStore),
      calls, idCalls,
      release: (models = [model]) => release(models), reject: () => reject(new Error("failed pass")),
      warm: (models = [model]) => { cached = { [provider]: models }; },
      next: () => { gate = new Promise((resolve, fail) => { release = resolve; reject = fail; }); },
    };
  }
  // Flush bootstrap and the curated-ID prefetch without real network/timeouts.
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  it("coalesces cold readers and a forced refresh into one population pass", async () => {
    const f = fixture();
    const readers = [f.service.getRoutstr21Models(), f.service.getRoutstr21Models(), f.service.getRoutstr21Models(true)];
    await flush();
    expect(f.calls).toEqual([false]);
    expect(f.idCalls).toEqual([false]);
    f.release();
    const results = await Promise.all(readers);
    expect(results.map(r => r[0]!.name)).toEqual(["Model", "Model", "Model"]);
  });

  it("joins a forced population pass but leaves warm reads cache-only", async () => {
    const f = fixture();
    f.warm();
    const forced = f.service.getRoutstr21Models(true);
    const cold = f.service.getRoutstr21Models();
    await flush();
    expect(f.calls).toEqual([true]);
    f.warm();
    expect((await f.service.getRoutstr21Models())[0]!.name).toBe("Model");
    expect(f.calls).toEqual([true]);
    f.release();
    await Promise.all([forced, cold]);
    f.next();
    const next = f.service.getRoutstr21Models(true);
    await flush();
    expect(f.calls).toEqual([true, true]);
    f.release();
    await next;
  });

  it("joins a cold pass after incremental cache publication instead of exposing pending models as stubs", async () => {
    const f = fixture(["m", "pending"]);
    const first = f.service.getRoutstr21Models();
    await flush();
    f.warm(); // SDK publishes provider A before provider B has answered.
    let settled = false;
    const second = f.service.getRoutstr21Models().then(models => { settled = true; return models; });
    await flush();
    expect(settled).toBe(false);
    expect(f.calls).toEqual([false]);
    const pending = { ...model, id: "pending", name: "Pending provider metadata" };
    f.release([model, pending]);
    for (const result of await Promise.all([first, second])) {
      expect(result[1]!.name).toBe("Pending provider metadata");
    }
  });

  for (const freshness of ["fresh", "expired"]) {
    it(`startup delegates ${freshness} cached payloads to SDK TTL checks without forcing`, async () => {
      const f = fixture();
      f.warm();
      const background = f.service.getRoutstr21Models(false, true);
      await flush();
      expect(f.calls).toEqual([false]);
      expect(f.idCalls).toEqual([false]);
      // A regular warm read remains independent even while startup checks TTL.
      expect((await f.service.getRoutstr21Models())[0]!.name).toBe("Model");
      expect(f.calls).toEqual([false]);
      f.release([{ ...model, name: freshness === "expired" ? "Refreshed" : "Model" }]);
      expect((await background)[0]!.name).toBe(freshness === "expired" ? "Refreshed" : "Model");
    });
  }

  it("clears a failed pass so the next request can retry", async () => {
    const f = fixture();
    const first = f.service.getRoutstr21Models().catch(error => error);
    await flush();
    f.reject();
    expect((await first).message).toBe("failed pass");
    f.next();
    const retry = f.service.getRoutstr21Models();
    await flush();
    expect(f.calls).toEqual([false, false]);
    f.release();
    expect(await retry).toHaveLength(1);
  });
});
