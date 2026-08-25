import { describe, expect, test } from "bun:test";
import { createModelService } from "../src/daemon/models";

const ACTIVE = "https://active.example/";
const DISABLED = "https://disabled.example/";
const NEWLY_DISCOVERED = "https://new.example/";

function createStore() {
  const state = {
    baseUrlsList: [ACTIVE, DISABLED],
    disabledProviders: [DISABLED],
    setBaseUrlsList(urls: string[]) {
      state.baseUrlsList = urls;
    },
    setDisabledProviders(urls: string[]) {
      state.disabledProviders = urls;
    },
  };

  return {
    state,
    store: { getState: () => state },
  };
}

function createModelManager(fetchCalls: string[][]) {
  return {
    bootstrapProviders: async () => [ACTIVE, DISABLED, NEWLY_DISCOVERED],
    fetchModels: async (providers: string[]) => {
      fetchCalls.push(providers);
      return [{ id: "test-model", name: "Test model" }];
    },
    fetchRoutstr21Models: async () => ["test-model"],
    getBaseUrls: () => [ACTIVE, DISABLED, NEWLY_DISCOVERED],
    getAllCachedModels: () => ({}),
    syncReviewedProvidersFromNostr: async () => [],
  };
}

describe("model provider filtering", () => {
  test("scheduled model fetch contacts only explicitly enabled providers", async () => {
    const fetchCalls: string[][] = [];
    const { store, state } = createStore();
    const service = createModelService(
      createModelManager(fetchCalls) as any,
      store as any,
    );

    await service.getRoutstr21Models(true);

    expect(fetchCalls).toEqual([[ACTIVE], [ACTIVE]]);
    expect(state.baseUrlsList).toContain(NEWLY_DISCOVERED);
    expect(state.disabledProviders).toContain(NEWLY_DISCOVERED);
  });

  test("forced refresh contacts only explicitly enabled providers", async () => {
    const fetchCalls: string[][] = [];
    const { store, state } = createStore();
    const service = createModelService(
      createModelManager(fetchCalls) as any,
      store as any,
    );

    await service.refreshProvidersAndModels();

    expect(fetchCalls).toEqual([[ACTIVE]]);
    expect(state.baseUrlsList).toEqual([ACTIVE, DISABLED, NEWLY_DISCOVERED]);
    expect(state.disabledProviders).toContain(NEWLY_DISCOVERED);
  });
});
