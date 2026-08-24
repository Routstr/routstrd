import { describe, it, expect } from "bun:test";
import type { SdkStore } from "@routstr/sdk";
import { createModelService } from "./models";

/**
 * `ensureProvidersBootstrapped` must mirror the review-disabled provider set
 * (kind 38425) into the SdkStore. The SDK applies review disables to the
 * discovery adapter during bootstrap, but `providers list` and per-model
 * provider views read the store — if the store is not kept in sync, a fresh
 * install reports "0 disabled" while routing silently excludes them.
 */
describe("createModelService.ensureProvidersBootstrapped", () => {
  function makeStore(initialBaseUrls: string[] = []) {
    const disabledCalls: string[][] = [];
    const state: Record<string, unknown> = {
      baseUrlsList: initialBaseUrls,
      setBaseUrlsList: (urls: string[]) => {
        state.baseUrlsList = urls;
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
});
