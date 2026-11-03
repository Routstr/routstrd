import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import { createSdkStore } from "@routstr/sdk";
import {
  createMemoryDriver,
  createShardedDiscoveryAdapter,
} from "@routstr/sdk/storage";
import { createDaemonRequestHandler } from "./index";

const PROVIDER_A = "https://provider-a.example/";
const PROVIDER_B = "https://provider-b.example/";
const PROVIDER_C = "https://provider-c.example/";

/** Labels the SDK enables out of the box; `sandbox` deliberately is not one. */
const DEFAULT_LABELS = ["trusted", "verified", "lgtm", "lgtm2"];
const NEGATIVE_LABELS = ["avoid", "suspicious", "blacklisted", "removed"];

function makeReq(method: string, path: string, body?: unknown) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = { host: "localhost" };
  // readBody attaches listeners synchronously; emit on the next tick.
  setImmediate(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res: any = {
    status: 0,
    body: "",
    writeHead(status: number) {
      res.status = status;
      return res;
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk;
      return res;
    },
    json() {
      return JSON.parse(res.body);
    },
  };
  return res;
}

function makeStore(
  baseUrlsList: string[],
  extraState: Record<string, unknown> = {},
) {
  const state: any = {
    baseUrlsList,
    disabledProviders: [] as string[],
    manuallyDisabledProviders: [] as string[],
    manuallyEnabledProviders: [] as string[],
    setDisabledProviders: (urls: string[]) => {
      state.disabledProviders = urls;
    },
    setManuallyDisabledProviders: (urls: string[]) => {
      state.manuallyDisabledProviders = urls;
    },
    setManuallyEnabledProviders: (urls: string[]) => {
      state.manuallyEnabledProviders = urls;
    },
    // Reachability slices, written by the SDK's model-refresh pass.
    lastModelsUpdate: {} as Record<string, number>,
    modelsFromAllProviders: {} as Record<string, unknown[]>,
    ...extraState,
  };
  return { getState: () => state, state };
}

/**
 * Mimics the SDK discovery adapter: URLs are normalized, the effective
 * disabled set is review-disabled ∪ manually-disabled minus
 * manually-enabled, and setDisabledProviders *replaces* the review set.
 */
function makeAdapter(baseUrlsList: string[]) {
  let reviewDisabled: string[] = [];
  let manualDisabled: string[] = [];
  let manualEnabled: string[] = [];
  return {
    getBaseUrlsList: () => [...baseUrlsList],
    getDisabledProviders: () =>
      [...new Set([...reviewDisabled, ...manualDisabled])].filter(
        (u) => !manualEnabled.includes(u),
      ),
    getManuallyDisabledProviders: () => [...manualDisabled],
    getManuallyEnabledProviders: () => [...manualEnabled],
    setDisabledProviders: (urls: string[]) => {
      reviewDisabled = [...urls];
    },
    setManuallyDisabledProviders: (urls: string[]) => {
      manualDisabled = [...urls];
    },
    setManuallyEnabledProviders: (urls: string[]) => {
      manualEnabled = [...urls];
    },
    // Test hook: what the kind-38425 review sync would compute.
    _setReviewDisabled: (urls: string[]) => {
      reviewDisabled = [...urls];
    },
    _getReviewDisabled: () => [...reviewDisabled],
  };
}

type ReviewFixture = {
  url: string;
  node: string;
};

type ReviewEntry = {
  node: string;
  label: string;
  createdAt: number;
  id?: string;
};

/**
 * Test double for the SDK ModelManager's review-label API. The policy lives in
 * the SDK now, so the mock mirrors it: default labels ∪ user opt-ins enable a
 * node; negative labels disable; no label fails closed.
 */
function makeModelManager(
  adapter: ReturnType<typeof makeAdapter>,
  providers: ReviewFixture[],
  reviews: ReviewEntry[],
) {
  const providerNodes = new Map<string, Set<string>>();
  for (const { url, node } of providers) {
    const set = providerNodes.get(url) ?? new Set<string>();
    set.add(node);
    providerNodes.set(url, set);
  }

  const latestLabelByNode = new Map<string, string>();
  for (const review of [...reviews].sort((a, b) => a.createdAt - b.createdAt)) {
    latestLabelByNode.set(review.node, review.label.toLowerCase());
  }

  const reviewEvents = reviews.map((review, index) => ({
    id: review.id ?? `rv-${review.node}-${review.label}-${review.createdAt}-${index}`,
    pubkey: "routstr",
    kind: 38425,
    created_at: review.createdAt,
    content: "",
    tags: [
      ["node", review.node],
      ["t", review.label],
    ],
  }));

  let userLabels: string[] = [];
  const enabledLabelSet = () => new Set([...DEFAULT_LABELS, ...userLabels]);
  const normalize = (label: string) => label.trim().toLowerCase();

  const labelsForUrl = (url: string): Array<string | undefined> =>
    [...(providerNodes.get(url) ?? new Set<string>())].map((node) =>
      latestLabelByNode.get(node),
    );

  return {
    getUserEnabledReviewLabels: () => [...userLabels],
    getEnabledReviewLabels: () => [...enabledLabelSet()],
    addUserEnabledReviewLabel: (label: string) => {
      const l = normalize(label);
      if (l && !userLabels.includes(l)) userLabels.push(l);
      return [...userLabels];
    },
    removeUserEnabledReviewLabel: (label: string) => {
      const l = normalize(label);
      userLabels = userLabels.filter((entry) => entry !== l);
      return [...userLabels];
    },
    matchProviderUrlsByLabels: async (
      labels: string[],
      urls: string[] = adapter.getBaseUrlsList(),
    ) => {
      const matchedUrls: string[] = [];
      const matchedLabels: string[] = [];
      const unmatchedLabels: string[] = [];
      for (const raw of labels) {
        const label = normalize(raw);
        if (!label) continue;
        let hit = false;
        for (const url of urls) {
          if (labelsForUrl(url).some((l) => l === label)) {
            hit = true;
            if (!matchedUrls.includes(url)) matchedUrls.push(url);
          }
        }
        if (hit) {
          if (!matchedLabels.includes(label)) matchedLabels.push(label);
        } else if (!unmatchedLabels.includes(label)) {
          unmatchedLabels.push(label);
        }
      }
      return { matchedUrls, matchedLabels, unmatchedLabels };
    },
    syncReviewedProvidersFromNostr: async (urls?: string[]) => {
      const list = urls ?? adapter.getBaseUrlsList();
      const enabled = new Set(adapter.getManuallyEnabledProviders());
      const enabledLabels = enabledLabelSet();
      const recomputed = list.filter((url) => {
        if (enabled.has(url)) return false;
        const labels = labelsForUrl(url);
        const hasEnabled = labels.some((l) => l && enabledLabels.has(l));
        const hasNegative = labels.some((l) => l && NEGATIVE_LABELS.includes(l));
        return hasNegative || !hasEnabled;
      });
      adapter.setDisabledProviders(recomputed);
      return recomputed;
    },
    getProviderReviewIndex: async () => ({
      providerNodes,
      reviewEvents,
      latestLabelByNode,
    }),
  };
}

function makeDeps(overrides: {
  baseUrlsList?: string[];
  providers?: ReviewFixture[];
  reviews?: ReviewEntry[];
  state?: Record<string, unknown>;
  reachability?: {
    lastModelsUpdate: Record<string, number>;
    modelsFromAllProviders: Record<string, unknown[]>;
  };
}) {
  const baseUrlsList = overrides.baseUrlsList ?? [PROVIDER_A, PROVIDER_B];
  const providers = overrides.providers ?? [
    { url: PROVIDER_A, node: "nodeA" },
    { url: PROVIDER_B, node: "nodeB" },
  ];
  // Both providers approved by default unless a test overrides the reviews.
  const reviews = overrides.reviews ?? [
    { node: "nodeA", label: "lgtm", createdAt: 10 },
    { node: "nodeB", label: "lgtm", createdAt: 10 },
  ];
  const store = makeStore(baseUrlsList, overrides.state);
  const adapter = {
    ...makeAdapter(baseUrlsList),
    getProviderLastUpdate: (baseUrl: string) =>
      overrides.reachability?.lastModelsUpdate[baseUrl] ?? null,
    getCachedModels: () => overrides.reachability?.modelsFromAllProviders ?? {},
  };
  const modelManager = makeModelManager(adapter, providers, reviews);
  const handler = createDaemonRequestHandler({
    store,
    discoveryAdapter: adapter,
    modelManager,
  } as any);
  return { handler, store, adapter, modelManager };
}

async function call(
  handler: Function,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = makeRes();
  await handler(makeReq(method, path, body), res);
  return res;
}

describe("GET /providers", () => {
  it("derives status from the discovery adapter, not the stale store mirror", async () => {
    const { handler, adapter } = makeDeps({});
    // Simulate a scheduled review sync that updated ONLY the adapter
    // (the store mirror lags behind by design).
    adapter._setReviewDisabled([PROVIDER_B]);

    const res = await call(handler, "GET", "/providers");
    expect(res.status).toBe(200);
    const { providers } = res.json().output;
    expect(providers[0]).toMatchObject({
      baseUrl: PROVIDER_A,
      disabled: false,
      manuallyDisabled: false,
      manuallyEnabled: false,
    });
    expect(providers[1]).toMatchObject({
      baseUrl: PROVIDER_B,
      disabled: true,
      manuallyDisabled: false,
      manuallyEnabled: false,
    });
  });

  it("reports manual enable/disable flags from the adapter", async () => {
    const { handler, adapter } = makeDeps({});
    adapter.setManuallyDisabledProviders([PROVIDER_A]);
    adapter.setManuallyEnabledProviders([PROVIDER_B]);

    const res = await call(handler, "GET", "/providers");
    const { providers } = res.json().output;
    expect(providers[0]).toMatchObject({
      disabled: true,
      manuallyDisabled: true,
      manuallyEnabled: false,
    });
    expect(providers[1]).toMatchObject({
      disabled: false,
      manuallyDisabled: false,
      manuallyEnabled: true,
    });
  });
});

describe("GET /providers reachability", () => {
  const FRESH = Date.now() - 60_000;
  const STALE = Date.now() - 7 * 24 * 60 * 60 * 1000;

  /** Store slices the SDK's model-refresh pass leaves behind. */
  const reachabilityState = (
    updates: Record<string, number>,
    models: Record<string, unknown[]> = {},
  ) => ({ lastModelsUpdate: updates, modelsFromAllProviders: models });

  it("reads live sharded adapter updates independently of the legacy store", async () => {
    const driver = createMemoryDriver();
    const { store, hydrate } = createSdkStore({ driver });
    await hydrate;
    store.getState().setBaseUrlsList([PROVIDER_A, PROVIDER_B, PROVIDER_C]);
    const adapter = await createShardedDiscoveryAdapter({ driver });
    const handler = createDaemonRequestHandler({
      store,
      discoveryAdapter: adapter,
    } as any);

    // Before a refresh, no evidence means fail open.
    expect((await call(handler, "GET", "/providers")).json().output.providers)
      .toHaveLength(3);

    // These are the same writes ModelManager makes after successful fetches.
    adapter.setCachedModels({ [PROVIDER_A]: [{ id: "m-1" } as any] });
    adapter.setProviderLastUpdate(PROVIDER_A, FRESH);
    adapter.setProviderLastUpdate(PROVIDER_C, STALE);
    expect(store.getState().lastModelsUpdate).toEqual({});
    expect(store.getState().modelsFromAllProviders).toEqual({});

    const out = (await call(handler, "GET", "/providers")).json().output;
    expect(out.providers).toEqual([
      expect.objectContaining({
        index: 0,
        baseUrl: PROVIDER_A,
        reachable: true,
        lastModelFetchAt: FRESH,
        modelCount: 1,
      }),
    ]);
    expect(out.hiddenCount).toBe(2);

    const all = (await call(handler, "GET", "/providers?all=true")).json().output;
    expect(all.providers[1].unreachableReason).toBe("never-fetched");
    expect(all.providers[2].unreachableReason).toBe("stale");

    // Recovery must be visible immediately without rehydrating SdkStore.
    adapter.setProviderLastUpdate(PROVIDER_B, FRESH);
    expect((await call(handler, "GET", "/providers")).json().output.providers
      .map((p: any) => p.index)).toEqual([0, 1]);
  });

  it("hides nodes that never answered and keeps discovery indices stable", async () => {
    const { handler } = makeDeps({
      baseUrlsList: [PROVIDER_A, PROVIDER_B, PROVIDER_C],
      reachability: reachabilityState(
        { [PROVIDER_A]: FRESH, [PROVIDER_C]: STALE },
        { [PROVIDER_A]: [{ id: "m-1" }, { id: "m-2" }] },
      ),
    });

    const out = (await call(handler, "GET", "/providers")).json().output;
    // PROVIDER_B never answered, PROVIDER_C is ~a week stale.
    expect(out.providers.map((p: any) => p.baseUrl)).toEqual([PROVIDER_A]);
    expect(out.providers[0]).toMatchObject({
      index: 0,
      reachable: true,
      lastModelFetchAt: FRESH,
      modelCount: 2,
    });
    expect(out.providers[0].unreachableReason).toBeUndefined();
    expect(out).toMatchObject({
      totalCount: 3,
      reachableCount: 1,
      unreachableCount: 2,
      hiddenCount: 2,
      includeUnreachable: false,
    });
  });

  it("reports every node with `all=true`, flagged with why it is unreachable", async () => {
    const { handler } = makeDeps({
      baseUrlsList: [PROVIDER_A, PROVIDER_B, PROVIDER_C],
      reachability: reachabilityState({ [PROVIDER_A]: FRESH, [PROVIDER_C]: STALE }),
    });

    const out = (await call(handler, "GET", "/providers?all=true")).json()
      .output;
    expect(out.providers.map((p: any) => p.baseUrl)).toEqual([
      PROVIDER_A,
      PROVIDER_B,
      PROVIDER_C,
    ]);
    // Indices address the full discovered list, so `providers disable 2`
    // keeps meaning PROVIDER_C whether or not unreachable nodes are listed.
    expect(out.providers.map((p: any) => p.index)).toEqual([0, 1, 2]);
    expect(out.providers.map((p: any) => p.reachable)).toEqual([
      true,
      false,
      false,
    ]);
    expect(out.providers[1]).toMatchObject({
      lastModelFetchAt: null,
      unreachableReason: "never-fetched",
    });
    expect(out.providers[2]).toMatchObject({
      lastModelFetchAt: STALE,
      unreachableReason: "stale",
    });
    expect(out).toMatchObject({ hiddenCount: 0, includeUnreachable: true });
  });

  it("keeps a manually enabled node listed while it is unreachable", async () => {
    const { handler, adapter } = makeDeps({
      baseUrlsList: [PROVIDER_A, PROVIDER_B],
      reachability: reachabilityState({ [PROVIDER_A]: FRESH }),
    });
    adapter.setManuallyEnabledProviders([PROVIDER_B]);

    const out = (await call(handler, "GET", "/providers")).json().output;
    expect(out.providers.map((p: any) => p.baseUrl)).toEqual([
      PROVIDER_A,
      PROVIDER_B,
    ]);
    expect(out.providers[1]).toMatchObject({
      reachable: false,
      manuallyEnabled: true,
      unreachableReason: "never-fetched",
    });
    expect(out.hiddenCount).toBe(0);
  });

  it("fails open when no node has answered yet (fresh install, pass running)", async () => {
    const { handler } = makeDeps({
      baseUrlsList: [PROVIDER_A, PROVIDER_B, PROVIDER_C],
    });

    const out = (await call(handler, "GET", "/providers")).json().output;
    // Hiding every node would be worse than showing a dead one.
    expect(out.providers).toHaveLength(3);
    expect(out.providers.every((p: any) => p.reachable === true)).toBe(true);
    expect(out.providers.every((p: any) => p.lastModelFetchAt === null)).toBe(
      true,
    );
    expect(out).toMatchObject({ hiddenCount: 0, unreachableCount: 0 });
  });
});

describe("POST /providers/nostr-sync", () => {
  it("re-enables nothing fail-open: recomputes the review verdict after clearing overrides", async () => {
    // Scenario from review: review-disabled -> manual enable -> scheduled
    // review refresh (adapter review set loses the provider) -> nostr-sync.
    const { handler, store, adapter, modelManager } = makeDeps({
      reviews: [
        { node: "nodeA", label: "sandbox", createdAt: 10 },
        { node: "nodeB", label: "lgtm", createdAt: 10 },
      ],
    });
    adapter._setReviewDisabled([PROVIDER_A]);
    store.state.disabledProviders = [PROVIDER_A];

    // User manually enables the review-rejected provider.
    const enableRes = await call(handler, "POST", "/providers/enable", {
      indices: [0],
    });
    expect(enableRes.status).toBe(200);
    expect(adapter.getDisabledProviders()).not.toContain(PROVIDER_A);

    // Scheduled review refresh runs: SDK skips manually-enabled providers
    // and overwrites the review-disabled set without PROVIDER_A.
    await modelManager.syncReviewedProvidersFromNostr();
    expect(adapter._getReviewDisabled()).toEqual([]);

    // nostr-sync must restore the review verdict, not the stale empty set.
    const res = await call(handler, "POST", "/providers/nostr-sync", {
      indices: [0],
    });
    expect(res.status).toBe(200);
    const out = res.json().output;
    expect(out.providers).toEqual([{ baseUrl: PROVIDER_A, disabled: true }]);

    // Routing state and the store mirror must agree with the verdict.
    expect(adapter.getDisabledProviders()).toContain(PROVIDER_A);
    expect(store.state.disabledProviders).toContain(PROVIDER_A);
    expect(adapter.getManuallyEnabledProviders()).toEqual([]);
    expect(adapter.getManuallyDisabledProviders()).toEqual([]);

    // And providers list must agree with routing.
    const listRes = await call(handler, "GET", "/providers");
    const { providers } = listRes.json().output;
    expect(providers[0].disabled).toBe(true);
  });

  it("returns a manually review-clean provider to enabled", async () => {
    const { handler, adapter } = makeDeps({});
    adapter.setManuallyDisabledProviders([PROVIDER_B]);

    const res = await call(handler, "POST", "/providers/nostr-sync", {
      indices: [1],
    });
    expect(res.status).toBe(200);
    expect(res.json().output.providers).toEqual([
      { baseUrl: PROVIDER_B, disabled: false },
    ]);
    expect(adapter.getManuallyDisabledProviders()).toEqual([]);
  });

  it("rejects requests with no valid indices", async () => {
    const { handler } = makeDeps({});
    for (const indices of [[0.5], [-1], [99], ["x"], [0.5, 99]]) {
      const res = await call(handler, "POST", "/providers/nostr-sync", {
        indices,
      });
      expect(res.status).toBe(400);
      expect(res.json().error).toContain("No valid indices");
    }
  });

  it("reports skipped indices on partial success and dedupes", async () => {
    const { handler } = makeDeps({});
    const res = await call(handler, "POST", "/providers/nostr-sync", {
      indices: [0, 99, 0.5, 0],
    });
    expect(res.status).toBe(200);
    const out = res.json().output;
    expect(out.providers).toEqual([{ baseUrl: PROVIDER_A, disabled: false }]);
    expect(out.skipped).toEqual([99, 0.5]);
  });

  it("rejects a missing indices field", async () => {
    const { handler } = makeDeps({});
    const res = await call(handler, "POST", "/providers/nostr-sync", {});
    expect(res.status).toBe(400);
  });
});

describe("POST /providers/enable (review labels)", () => {
  const sandboxFixture = {
    reviews: [
      { node: "nodeA", label: "lgtm", createdAt: 10 },
      { node: "nodeB", label: "sandbox", createdAt: 10 },
    ],
  };

  it("opts the label into the policy and enables matching providers", async () => {
    const { handler, adapter, modelManager } = makeDeps(sandboxFixture);
    // Sandbox is disabled by default.
    adapter._setReviewDisabled([PROVIDER_B]);

    const res = await call(handler, "POST", "/providers/enable", {
      labels: ["sandbox"],
    });
    expect(res.status).toBe(200);
    const out = res.json().output;
    expect(out.enabled).toEqual([PROVIDER_B]);
    expect(out.matchedLabels).toEqual(["sandbox"]);
    expect(out.enabledLabels).toContain("sandbox");
    // Enabled by label policy, not a per-URL manual override.
    expect(modelManager.getUserEnabledReviewLabels()).toEqual(["sandbox"]);
    expect(adapter.getManuallyEnabledProviders()).not.toContain(PROVIDER_B);
    expect(adapter.getDisabledProviders()).not.toContain(PROVIDER_B);
  });

  it("matches against the newest review label per node", async () => {
    const { handler, adapter } = makeDeps({
      reviews: [
        { node: "nodeA", label: "lgtm", createdAt: 10 },
        // Older sandbox review is superseded by a newer lgtm: no match.
        { node: "nodeB", label: "sandbox", createdAt: 10 },
        { node: "nodeB", label: "lgtm", createdAt: 20 },
      ],
    });
    const res = await call(handler, "POST", "/providers/enable", {
      labels: ["sandbox"],
    });
    expect(res.json().output.enabled).toEqual([]);
    expect(res.json().output.unmatchedLabels).toEqual(["sandbox"]);
    // The newer lgtm keeps the provider enabled regardless.
    expect(adapter.getDisabledProviders()).not.toContain(PROVIDER_B);
  });

  it("reports labels that matched no provider", async () => {
    const { handler } = makeDeps({});
    const res = await call(handler, "POST", "/providers/enable", {
      labels: ["sandbox", "nope"],
    });
    expect(res.status).toBe(200);
    expect(res.json().output.enabled).toEqual([]);
    expect(res.json().output.unmatchedLabels).toEqual(["sandbox", "nope"]);
  });

  it("accepts indices and labels together", async () => {
    const { handler, adapter } = makeDeps(sandboxFixture);
    const res = await call(handler, "POST", "/providers/enable", {
      indices: [0],
      labels: ["sandbox"],
    });
    expect(res.status).toBe(200);
    const out = res.json().output;
    expect(out.enabled.sort()).toEqual([PROVIDER_A, PROVIDER_B].sort());
    // Index target is a per-URL manual override; the label is policy-level.
    expect(adapter.getManuallyEnabledProviders()).toEqual([PROVIDER_A]);
  });

  it("rejects a request with neither indices nor labels", async () => {
    const { handler } = makeDeps({});
    const res = await call(handler, "POST", "/providers/enable", {});
    expect(res.status).toBe(400);
  });
});

describe("POST /providers/disable (review labels)", () => {
  it("dropping a label returns matching providers to the review verdict", async () => {
    const { handler, adapter, modelManager } = makeDeps({
      reviews: [
        { node: "nodeA", label: "lgtm", createdAt: 10 },
        { node: "nodeB", label: "sandbox", createdAt: 10 },
      ],
    });

    await call(handler, "POST", "/providers/enable", { labels: ["sandbox"] });
    expect(adapter.getDisabledProviders()).not.toContain(PROVIDER_B);

    const res = await call(handler, "POST", "/providers/disable", {
      labels: ["sandbox"],
    });
    expect(res.status).toBe(200);
    const out = res.json().output;
    expect(out.disabled).toContain(PROVIDER_B);
    expect(out.matchedLabels).toEqual(["sandbox"]);
    expect(modelManager.getUserEnabledReviewLabels()).toEqual([]);
    expect(adapter.getDisabledProviders()).toContain(PROVIDER_B);
  });

  it("rejects a request with neither indices nor labels", async () => {
    const { handler } = makeDeps({});
    const res = await call(handler, "POST", "/providers/disable", {});
    expect(res.status).toBe(400);
  });
});

describe("provider policy effective results", () => {
  const sandboxFixture = {
    reviews: [
      { node: "nodeA", label: "lgtm", createdAt: 10 },
      { node: "nodeB", label: "sandbox", createdAt: 10 },
    ],
  };

  it("does not report a manually disabled label match as enabled", async () => {
    const { handler, adapter } = makeDeps(sandboxFixture);
    await call(handler, "POST", "/providers/disable", { indices: [1] });
    const res = await call(handler, "POST", "/providers/enable", { labels: ["sandbox"] });
    expect(res.status).toBe(200);
    expect(res.json().output).toMatchObject({
      enabled: [], matchedUrls: [PROVIDER_B], remainingDisabled: [PROVIDER_B],
      enabledLabels: ["sandbox"],
    });
    expect(res.json().output.message).toContain("0 targeted provider(s) currently enabled");
    expect(adapter.getManuallyDisabledProviders()).toEqual([PROVIDER_B]);
    expect(adapter.getDisabledProviders()).toContain(PROVIDER_B);
  });

  it("does not report a manually enabled label match as disabled", async () => {
    const { handler, adapter } = makeDeps(sandboxFixture);
    await call(handler, "POST", "/providers/enable", { indices: [1], labels: ["sandbox"] });
    const res = await call(handler, "POST", "/providers/disable", { labels: ["sandbox"] });
    expect(res.json().output).toMatchObject({
      disabled: [], matchedUrls: [PROVIDER_B], remainingEnabled: [PROVIDER_B],
      enabledLabels: [],
    });
    expect(res.json().output.message).toContain("0 targeted provider(s) currently disabled");
    expect(adapter.getManuallyEnabledProviders()).toEqual([PROVIDER_B]);
    expect(adapter.getDisabledProviders()).not.toContain(PROVIDER_B);
  });

  it("reports immutable default labels and providers that remain enabled", async () => {
    const { handler, adapter } = makeDeps({});
    const res = await call(handler, "POST", "/providers/disable", { labels: ["LGTM"] });
    expect(res.json().output).toMatchObject({
      disabled: [], matchedUrls: [PROVIDER_A, PROVIDER_B],
      remainingEnabled: [PROVIDER_A, PROVIDER_B], enabledLabels: [],
      enabledReviewLabels: DEFAULT_LABELS,
    });
    expect(adapter.getDisabledProviders()).toEqual([]);
  });

  it("partitions mixed index and label targets by effective state", async () => {
    const { handler } = makeDeps(sandboxFixture);
    await call(handler, "POST", "/providers/disable", { indices: [1] });
    const res = await call(handler, "POST", "/providers/enable", { indices: [0], labels: ["sandbox"] });
    expect(res.json().output).toMatchObject({
      enabled: [PROVIDER_A], matchedUrls: [PROVIDER_B], remainingDisabled: [PROVIDER_B],
    });
  });

  it("does not claim a transition when an index is already enabled", async () => {
    const { handler } = makeDeps({});
    const res = await call(handler, "POST", "/providers/enable", { indices: [0] });
    expect(res.json().output.enabled).toEqual([PROVIDER_A]);
    expect(res.json().output.message).toBe("1 targeted provider(s) currently enabled.");
  });
});

describe("provider policy concurrent requests", () => {
  for (const action of ["enable", "disable"] as const) {
    for (const mixed of [false, true]) {
      it(`${action} with ${mixed ? "indices and labels" : "labels only"} preserves concurrent manual changes`, async () => {
        const { handler, store, adapter, modelManager } = makeDeps({});
        const opposite = action === "enable" ? "disable" : "enable";
        if (action === "disable") {
          await call(handler, "POST", "/providers/disable", { indices: [0] });
        }

        let signalEntered!: () => void;
        let release!: () => void;
        const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const match = modelManager.matchProviderUrlsByLabels;
        modelManager.matchProviderUrlsByLabels = async (...args) => {
          signalEntered();
          await gate;
          return match(...args);
        };

        // A label-only operation must not even persist replacement manual arrays.
        let manualWrites = 0;
        const state = store.getState();
        const setDisabled = state.setManuallyDisabledProviders;
        const setEnabled = state.setManuallyEnabledProviders;
        state.setManuallyDisabledProviders = (urls: string[]) => {
          manualWrites++;
          setDisabled(urls);
        };
        state.setManuallyEnabledProviders = (urls: string[]) => {
          manualWrites++;
          setEnabled(urls);
        };

        const pending = call(handler, "POST", `/providers/${action}`, {
          labels: ["lgtm"],
          ...(mixed ? { indices: [1] } : {}),
        });
        await entered;
        let concurrentWrites = 0;
        try {
          const concurrent = await call(handler, "POST", `/providers/${opposite}`, {
            indices: [0],
          });
          expect(concurrent.status).toBe(200);
          concurrentWrites = manualWrites;
        } finally {
          release();
        }
        expect((await pending).status).toBe(200);
        expect(manualWrites - concurrentWrites).toBe(mixed ? 2 : 0);

        const disabled = action === "enable" ? [PROVIDER_A] : mixed ? [PROVIDER_B] : [];
        const enabled = action === "disable" ? [PROVIDER_A] : mixed ? [PROVIDER_B] : [];
        expect(store.state.manuallyDisabledProviders).toEqual(disabled);
        expect(store.state.manuallyEnabledProviders).toEqual(enabled);
        expect(adapter.getManuallyDisabledProviders()).toEqual(disabled);
        expect(adapter.getManuallyEnabledProviders()).toEqual(enabled);
        expect(adapter.getDisabledProviders()).toEqual(disabled);
      });
    }
  }
});

describe("GET /providers/reviews", () => {
  it("reports each provider's review events, latest labels and enabled labels", async () => {
    const { handler } = makeDeps({
      reviews: [{ node: "nodeA", label: "sandbox", createdAt: 10, id: "rv1" }],
    });
    const res = await call(handler, "GET", "/providers/reviews");
    expect(res.status).toBe(200);
    const out = res.json().output;
    expect(out.enabledLabels).toEqual(DEFAULT_LABELS);
    const providerA = out.providers.find((p: any) => p.baseUrl === PROVIDER_A);
    expect(providerA.reviewCount).toBe(1);
    expect(providerA.labels).toEqual(["sandbox"]);
    expect(providerA.reviews[0]).toMatchObject({
      eventId: "rv1",
      label: "sandbox",
      nodePubkey: "nodeA",
    });
  });
});

describe("wallet errors", () => {
  it("maps a WalletHttpError onto its HTTP status", async () => {
    const handler = createDaemonRequestHandler({
      walletClient: { getMintQuote: async () => null },
    } as any);
    const res = await call(handler, "GET", "/wallet/receive/bolt11/missing");
    expect(res.status).toBe(404);
    expect(res.json()).toEqual({ error: "Mint quote not found" });
  });
});
