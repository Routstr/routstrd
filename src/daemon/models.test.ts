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
