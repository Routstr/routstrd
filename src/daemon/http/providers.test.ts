import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import { createDaemonRequestHandler } from "./index";

const PROVIDER_A = "https://provider-a.example/";
const PROVIDER_B = "https://provider-b.example/";

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

function makeStore(baseUrlsList: string[]) {
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
  const store = makeStore(baseUrlsList);
  const adapter = makeAdapter(baseUrlsList);
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
