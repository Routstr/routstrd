import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import { createDaemonRequestHandler } from "./index";

const PROVIDER_A = "https://provider-a.example/";
const PROVIDER_B = "https://provider-b.example/";

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

/**
 * Mimics ModelManager.syncReviewedProvidersFromNostr semantics: rebuild the
 * review-disabled set from the current verdicts, SKIPPING manually enabled
 * providers (this skip is what makes a stale disabled set fail open).
 */
function makeModelManager(
  adapter: ReturnType<typeof makeAdapter>,
  reviewRejected: Set<string>,
) {
  return {
    syncReviewedProvidersFromNostr: async (baseUrls?: string[]) => {
      const urls = baseUrls ?? adapter.getBaseUrlsList();
      const enabled = new Set(adapter.getManuallyEnabledProviders());
      const recomputed = urls.filter(
        (u) => reviewRejected.has(u) && !enabled.has(u),
      );
      adapter.setDisabledProviders(recomputed);
      return recomputed;
    },
  };
}

function makeDeps(overrides: {
  baseUrlsList?: string[];
  reviewRejected?: Set<string>;
}) {
  const baseUrlsList = overrides.baseUrlsList ?? [PROVIDER_A, PROVIDER_B];
  const store = makeStore(baseUrlsList);
  const adapter = makeAdapter(baseUrlsList);
  const reviewRejected = overrides.reviewRejected ?? new Set<string>();
  const modelManager = makeModelManager(adapter, reviewRejected);
  const handler = createDaemonRequestHandler({
    store,
    discoveryAdapter: adapter,
    modelManager,
  } as any);
  return { handler, store, adapter, modelManager, reviewRejected };
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
    const { handler, adapter } = makeDeps({
      reviewRejected: new Set([PROVIDER_B]),
    });
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
    const { handler, store, adapter, modelManager, reviewRejected } =
      makeDeps({ reviewRejected: new Set([PROVIDER_A]) });
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
