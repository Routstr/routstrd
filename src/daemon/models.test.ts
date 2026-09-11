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
