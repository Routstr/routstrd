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

/**
 * `getModelPaths` is the `routstrd models -m <id> --paths` inventory: every
 * enabled node that serves the model, with its advertised upstream routes.
 *
 * The ranking it must reproduce is the router's, not "cheapest route wins":
 * the SDK ranks a node on the completion price of the route it would use first
 * (a whitelisted route when the node advertises one), so the display order
 * matches what a request would actually pick. Nodes the inventory cannot cover
 * (cooldown, no paths, failed lookup) are reported instead of vanishing.
 */
describe("createModelService.getModelPaths", () => {
  const MODEL_ID = "deepseek-v4.1-flash";
  const PIN_DEEPSEEK =
    "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek";
  const PIN_FIREWORKS =
    "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=fireworks";
  const CHEAP_DECART =
    "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=decart%2Ffp4";
  const VENICE_ALIAS =
    "url=https%3A%2F%2Fapi.venice.ai%2Fapi%2Fv1&model-id=deepseek-v4-1-flash";

  const catalogModel = (overrides: Record<string, unknown> = {}) => ({
    id: MODEL_ID,
    name: "DeepSeek V4.1 Flash",
    description: "flashy",
    context_length: 1_000_000,
    sats_pricing: {
      prompt: 0.0002,
      completion: 0.0008,
      request: 0,
      max_cost: 0,
      input_cache_read: 0.00002,
      input_cache_write: 0,
    },
    ...overrides,
  });

  const nodePaths = (
    paths: Array<{ path: string; model?: unknown }>,
    id: string = MODEL_ID,
    aliasIds: string[] = [],
  ) => ({ data: [{ id, paths, alias_ids: aliasIds }], updatedAt: null });

  const priced = (prompt: number, completion: number) => ({
    sats_pricing: { prompt, completion, request: 0, max_cost: 0 },
  });

  function makeService(options: {
    cached: Record<string, unknown[]>;
    disabled?: string[];
    cooledNodes?: string[];
    cooledPaths?: string[];
    fetchNodeModelPaths: (baseUrl: string) => unknown;
    mappings?: Record<string, string>;
  }) {
    const state: Record<string, unknown> = {
      baseUrlsList: Object.keys(options.cached),
      setBaseUrlsList: () => {},
      disabledProviders: options.disabled ?? [],
      setDisabledProviders: () => {},
      manuallyDisabledProviders: [],
      manuallyEnabledProviders: [],
    };
    const cooledNodes = new Set(options.cooledNodes ?? []);
    const cooledPaths = new Set(options.cooledPaths ?? []);
    const service = createModelService(
      {
        bootstrapProviders: async () => Object.keys(options.cached),
        syncReviewedProvidersFromNostr: async () => null,
        getAllCachedModels: () => options.cached,
        getBaseUrls: () => Object.keys(options.cached),
        getModelIdMappings: () => options.mappings ?? {},
      } as never,
      {
        isOnCooldown: (baseUrl: string, _modelId?: string, path?: string) =>
          cooledNodes.has(baseUrl) ||
          (path !== undefined && cooledPaths.has(`${baseUrl}|${path}`)),
      } as never,
      { getState: () => state } as never,
      undefined,
      {
        fetchNodeModelPaths: (async (baseUrl: string) =>
          options.fetchNodeModelPaths(baseUrl)) as never,
      },
    );
    return service;
  }

  it("ranks nodes on the route routing would use first, not the cheapest route", async () => {
    const service = makeService({
      cached: {
        "https://a.example/": [catalogModel()],
        "https://b.example/": [catalogModel()],
      },
      fetchNodeModelPaths: (baseUrl) =>
        baseUrl === "https://b.example/"
          ? nodePaths([{ path: PIN_FIREWORKS, model: priced(0.0004, 0.0005) }])
          : nodePaths([
              // Expensive on the warm basket: 100k*0.0005 + 2k*0.002 = 54
              // sats, where b.example/'s pinned route costs 41.
              { path: PIN_DEEPSEEK, model: priced(0.0005, 0.002) },
              // Cheaper than any pinned route (10.2 sats), so a "cheapest
              // wins" ranking would put a.example/ first — routing would not.
              { path: CHEAP_DECART, model: priced(0.0001, 0.0001) },
            ]),
    });

    const output = (await service.getModelPaths(MODEL_ID))!;

    expect(output.nodes.map((node) => node.baseUrl)).toEqual([
      "https://b.example/",
      "https://a.example/",
    ]);
    // The node's rank is the warm-basket cost of the route routing would use
    // first — its pinned route — not of its cheapest one.
    expect(output.nodes[1]!.rankCost).toBeCloseTo(54, 6);
    expect(output.nodes[1]!.rankedOnPin).toBe(true);
    expect(output.nodes[1]!.routes.map((route) => route.path)).toEqual([
      CHEAP_DECART,
      PIN_DEEPSEEK,
    ]);
    expect(
      output.nodes[1]!.routes.find((route) => route.path === PIN_DEEPSEEK)!.pinned,
    ).toBe(true);
    expect(output.name).toBe("DeepSeek V4.1 Flash");
    expect(output.skipped).toEqual([]);
  });

  it("falls back to the model-level price and metadata for path-less per-route metadata", async () => {
    const service = makeService({
      cached: { "https://a.example/": [catalogModel()] },
      fetchNodeModelPaths: () => nodePaths([{ path: PIN_DEEPSEEK }]),
    });

    const route = (await service.getModelPaths(MODEL_ID))!.nodes[0]!.routes[0]!;

    expect(route.pricingSource).toBe("model");
    expect(route.pricing).toEqual({
      prompt: 0.0002,
      completion: 0.0008,
      request: 0,
      max_cost: 0,
      // The fallback carries the node's advertised cache rates too; a rate it
      // did not announce stays 0 (rendered as "-"), never a fake discount.
      input_cache_read: 0.00002,
      input_cache_write: 0,
    });
    expect(route.contextLength).toBe(1_000_000);
    expect(route.pinned).toBe(true);
  });

  it("dedupes a route advertised under two spellings but keeps a different upstream model-id", async () => {
    const service = makeService({
      cached: { "https://a.example/": [catalogModel()] },
      fetchNodeModelPaths: () =>
        nodePaths(
          [
            { path: PIN_DEEPSEEK, model: priced(0.0002, 0.0015) },
            { path: VENICE_ALIAS, model: priced(0.0005, 0.0018) },
          ],
          MODEL_ID,
          ["deepseek-v4-1-flash"],
        ),
    });

    const routes = (await service.getModelPaths(MODEL_ID))!.nodes[0]!.routes;

    expect(routes).toHaveLength(2);
    const venice = routes.find((route) => route.upstream.includes("venice"))!;
    expect(venice.endpoint).toBeNull();
    expect(venice.modelId).toBe("deepseek-v4-1-flash");
    expect(routes.find((route) => route.path === PIN_DEEPSEEK)!.modelId).toBe(
      MODEL_ID,
    );
  });

  it("marks no pinned route for a model the SDK does not auto-pin", async () => {
    // venice/api.ppq.ai are whitelisted upstreams, but the whitelist only
    // governs the auto-pinned model: claiming a pin for glm-5.3 would describe
    // failover routing that never happens.
    const service = makeService({
      cached: { "https://a.example/": [{ ...catalogModel(), id: "glm-5.3" }] },
      fetchNodeModelPaths: () =>
        nodePaths([{ path: VENICE_ALIAS, model: priced(0.0005, 0.0018) }], "glm-5.3"),
    });

    const node = (await service.getModelPaths("glm-5.3"))!.nodes[0]!;

    expect(node.routes[0]!.pinned).toBe(false);
    expect(node.rankedOnPin).toBe(false);
    // 100k*0.0005 + 2k*0.0018 = 53.6 sats for one warm request.
    expect(node.rankCost).toBeCloseTo(53.6, 6);
  });

  it("reports nodes it could not cover instead of dropping them silently", async () => {
    const service = makeService({
      cached: {
        "https://disabled.example/": [catalogModel()],
        "https://cooled.example/": [catalogModel()],
        "https://legacy.example/": [catalogModel()],
        "https://broken.example/": [catalogModel()],
        "https://other.example/": [{ ...catalogModel(), id: "glm-5.3" }],
      },
      disabled: ["https://disabled.example/"],
      cooledNodes: ["https://cooled.example/"],
      fetchNodeModelPaths: (baseUrl) => {
        if (baseUrl === "https://legacy.example/") return nodePaths([]);
        if (baseUrl === "https://broken.example/") return null;
        return nodePaths([{ path: PIN_DEEPSEEK, model: priced(0.0002, 0.0015) }]);
      },
    });

    const output = (await service.getModelPaths(MODEL_ID))!;

    expect(output.nodes).toEqual([]);
    expect(output.skipped).toEqual([
      { baseUrl: "https://broken.example/", reason: "model-path lookup failed" },
      { baseUrl: "https://cooled.example/", reason: "on cooldown" },
      { baseUrl: "https://legacy.example/", reason: "no model paths advertised" },
    ]);
    // A disabled node is never probed, and `other.example/` serves a
    // different model.
    expect(output.nodes).toEqual([]);
  });

  it("includes a disabled node, marked, when includeDisabled asks for it", async () => {
    const probed: string[] = [];
    const service = makeService({
      cached: {
        "https://off.example/": [catalogModel()],
        "https://on.example/": [catalogModel()],
      },
      disabled: ["https://off.example/"],
      fetchNodeModelPaths: (baseUrl) => {
        probed.push(baseUrl);
        return nodePaths([{ path: PIN_DEEPSEEK, model: priced(0.0002, 0.0015) }]);
      },
    });

    const hidden = (await service.getModelPaths(MODEL_ID))!;
    expect(probed).toEqual(["https://on.example/"]);
    expect(hidden.nodes.map((node) => node.baseUrl)).toEqual([
      "https://on.example/",
    ]);
    // An enabled node's payload does not grow a flag for a view it is not in.
    expect(hidden.nodes[0]!.disabled).toBeUndefined();

    probed.length = 0;
    const shown = (await service.getModelPaths(MODEL_ID, false, true))!;
    expect(probed.sort()).toEqual([
      "https://off.example/",
      "https://on.example/",
    ]);
    // The disabled node is priced and ranked like any other one; the flag is
    // the only thing that distinguishes it.
    expect(shown.nodes.map((node) => [node.baseUrl, node.disabled === true])).toEqual([
      ["https://off.example/", true],
      ["https://on.example/", false],
    ]);
    expect(shown.nodes[0]!.routes).toHaveLength(1);
    // 100k prompt (no cache rate advertised, so the whole prompt bills at the
    // prompt rate) + 2k completion: 20 + 3 = 23 sats for one warm request.
    expect(shown.nodes[0]!.rankCost).toBeCloseTo(23, 6);
    expect(shown.skipped).toEqual([]);
  });

  it("still reports a disabled node's real failures under skipped", async () => {
    const service = makeService({
      cached: { "https://off.example/": [catalogModel()] },
      disabled: ["https://off.example/"],
      fetchNodeModelPaths: () => null,
    });

    const output = (await service.getModelPaths(MODEL_ID, false, true))!;

    expect(output.nodes).toEqual([]);
    expect(output.skipped).toEqual([
      { baseUrl: "https://off.example/", reason: "model-path lookup failed" },
    ]);
  });

  it("lists a node whose routes are all on path-scoped cooldown, without a rank", async () => {
    const service = makeService({
      cached: { "https://a.example/": [catalogModel()] },
      cooledPaths: [`https://a.example/|${PIN_DEEPSEEK}`],
      fetchNodeModelPaths: () =>
        nodePaths([{ path: PIN_DEEPSEEK, model: priced(0.0002, 0.0015) }]),
    });

    const node = (await service.getModelPaths(MODEL_ID))!.nodes[0]!;

    expect(node.routes[0]!.onCooldown).toBe(true);
    expect(node.routes[0]!.pinned).toBe(false);
    expect(node.rankCost).toBeNull();
    expect(node.rankedOnPin).toBe(false);
  });

  it("returns null when no node serves the model", async () => {
    const service = makeService({
      cached: { "https://a.example/": [{ ...catalogModel(), id: "glm-5.3" }] },
      fetchNodeModelPaths: () => nodePaths([{ path: PIN_DEEPSEEK }]),
    });

    expect(await service.getModelPaths(MODEL_ID)).toBeNull();
  });
});

/**
 * `GET /models/:id/providers` is the CLI's pricing table, so it must carry the
 * rates the router ranks on *and* say where each cache rate came from: the SDK
 * fills a cache rate the node never announced with the prompt rate, and a
 * display that presents that fill as a cache price claims a discount the node
 * does not offer.
 */
describe("createModelService.getModelProviders", () => {
  const MODEL_ID = "deepseek-v4.1-flash-1017";

  const catalogModel = () => ({
    id: MODEL_ID,
    name: "DeepSeek V4.1 Flash 1017",
    description: "deepseek via ccm",
    context_length: 1_048_576,
    sats_pricing: { prompt: 0.0002, completion: 0.0008, max_cost: 446 },
  });

  const entry = (
    baseUrl: string,
    rates: {
      prompt?: number;
      completion?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cacheReadSource?: "advertised" | "prompt";
      cacheWriteSource?: "advertised" | "prompt";
    },
  ) => ({
    baseUrl,
    model: catalogModel(),
    cost: 1,
    rates: {
      prompt: rates.prompt ?? 0.0002,
      completion: rates.completion ?? 0.0008,
      request: 0.001,
      cacheRead: rates.cacheRead ?? 0.0002,
      cacheWrite: rates.cacheWrite ?? 0.0002,
      cacheReadSource: rates.cacheReadSource ?? "prompt",
      cacheWriteSource: rates.cacheWriteSource ?? "prompt",
    },
    breakdown: {},
    basket: {},
  });

  function makeService(
    ranking: unknown[],
    disabled: string[] = [],
    // The SDK caches a provider's models whether or not routing includes it,
    // which is what lets metadata resolve for a model only disabled nodes
    // serve.
    cached: Record<string, unknown[]> = {
      "https://a.example/": [catalogModel()],
    },
  ) {
    const state: Record<string, unknown> = {
      baseUrlsList: ranking.map((e) => (e as { baseUrl: string }).baseUrl),
      setBaseUrlsList: () => {},
      disabledProviders: disabled,
      setDisabledProviders: () => {},
      manuallyDisabledProviders: [],
      manuallyEnabledProviders: [],
    };
    return createModelService(
      {
        bootstrapProviders: async () => state.baseUrlsList,
        syncReviewedProvidersFromNostr: async () => null,
        getAllCachedModels: () => cached,
        getBaseUrls: () => Object.keys(cached),
        getModelIdMappings: () => ({}),
      } as never,
      { getProviderPriceRankingForModel: () => ranking } as never,
      { getState: () => state } as never,
    );
  }

  it("exposes the SDK rates with cache provenance and the store's disabled flag", async () => {
    const service = makeService(
      [
        entry("https://a.example/", {
          prompt: 0.0003,
          completion: 0.0009,
          cacheRead: 0.00005,
          cacheReadSource: "advertised",
        }),
        entry("https://b.example/", { cacheRead: 0.0002 }),
      ],
      ["https://b.example/"],
    );

    // `includeDisabled`: the CLI's --all, which is what shows a disabled
    // node's row.
    const output = await service.getModelProviders(MODEL_ID, true);

    expect(output?.id).toBe(MODEL_ID);
    expect(output?.name).toBe("DeepSeek V4.1 Flash 1017");
    expect(output?.hiddenProviders).toBe(0);
    expect(output?.providers).toEqual([
      {
        baseUrl: "https://a.example/",
        disabled: false,
        pricing: {
          prompt: 0.0003,
          completion: 0.0009,
          request: 0.001,
          max_cost: 446,
          cache: {
            read: 0.00005,
            write: 0.0002,
            readAdvertised: true,
            writeAdvertised: false,
          },
        },
      },
      {
        baseUrl: "https://b.example/",
        disabled: true,
        pricing: {
          prompt: 0.0002,
          completion: 0.0008,
          request: 0.001,
          max_cost: 446,
          cache: {
            // The SDK filled this from the prompt rate; it must not read as
            // an advertised cache price.
            read: 0.0002,
            write: 0.0002,
            readAdvertised: false,
            writeAdvertised: false,
          },
        },
      },
    ]);
  });

  it("hides disabled nodes by default and counts them", async () => {
    const service = makeService(
      [
        entry("https://a.example/", {}),
        entry("https://off.example/", {}),
        entry("https://b.example/", {}),
      ],
      ["https://off.example/"],
    );

    const output = await service.getModelProviders(MODEL_ID);

    // Routing skips `off.example/`, so its price is not one a request can
    // get: the default table lists only the nodes a request can use, in the
    // SDK's ranking order.
    expect(output?.providers.map((provider) => provider.baseUrl)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
    expect(output?.hiddenProviders).toBe(1);
  });

  it("returns the model with no providers when only disabled nodes serve it", async () => {
    // Not null: the CLI turns null into "Model not found" + exit 1, which
    // would be a lie about a model that exists and is merely unroutable.
    const service = makeService(
      [
        entry("https://off-a.example/", {}),
        entry("https://off-b.example/", {}),
      ],
      ["https://off-a.example/", "https://off-b.example/"],
      {
        "https://off-a.example/": [catalogModel()],
        "https://off-b.example/": [catalogModel()],
      },
    );

    const output = await service.getModelProviders(MODEL_ID);

    expect(output).not.toBeNull();
    expect(output?.id).toBe(MODEL_ID);
    // Metadata still resolves, so the CLI can name the model it is refusing.
    expect(output?.name).toBe("DeepSeek V4.1 Flash 1017");
    expect(output?.providers).toEqual([]);
    expect(output?.hiddenProviders).toBe(2);
  });

  it("returns null when no node serves the model", async () => {
    expect(await makeService([]).getModelProviders(MODEL_ID)).toBeNull();
  });
});
