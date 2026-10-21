import { describe, expect, it } from "bun:test";
import {
  decodeModelPathSelector,
  formatModelPaths,
  rankModelPathNodes,
  type ModelPathRoute,
  type ModelPathsOutput,
} from "./model-paths";

function route(partial: Partial<ModelPathRoute> = {}): ModelPathRoute {
  return {
    path: partial.path ?? "url=https%3A%2F%2Fapi.ppq.ai&model-id=deepseek-v4.1-flash",
    upstream: partial.upstream ?? "https://api.ppq.ai",
    endpoint: partial.endpoint ?? null,
    modelId: partial.modelId ?? "deepseek-v4.1-flash",
    pricing: partial.pricing === undefined
      ? { prompt: 0.0002, completion: 0.0008, request: 0, max_cost: 0 }
      : partial.pricing,
    pricingSource: partial.pricingSource ?? "path",
    contextLength: partial.contextLength ?? 1000000,
    maxCompletionTokens: partial.maxCompletionTokens ?? null,
    onCooldown: partial.onCooldown ?? false,
    pinned: partial.pinned ?? false,
  };
}

describe("decodeModelPathSelector", () => {
  it("decodes quote_plus parts, including the endpoint tag", () => {
    expect(
      decodeModelPathSelector(
        "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=decart%2Ffp4",
      ),
    ).toEqual({
      upstream: "https://openrouter.ai/api/v1",
      modelId: "deepseek-v4.1-flash",
      endpoint: "decart/fp4",
    });
  });

  it("decodes + as a space, like the node's quote_plus encoding", () => {
    expect(
      decodeModelPathSelector("url=https%3A%2F%2Fx.example%2Fv1&model-id=a+b"),
    ).toEqual({ upstream: "https://x.example/v1", modelId: "a b", endpoint: null });
  });

  it("tolerates and ignores the legacy provider-id parameter", () => {
    expect(
      decodeModelPathSelector(
        "url=https%3A%2F%2Fapi.ppq.ai&model-id=deepseek-v4.1-flash&provider-id=1",
      ),
    ).toEqual({
      upstream: "https://api.ppq.ai",
      modelId: "deepseek-v4.1-flash",
      endpoint: null,
    });
  });

  it("rejects malformed selectors", () => {
    expect(decodeModelPathSelector("")).toBeNull();
    expect(decodeModelPathSelector("url=https%3A%2F%2Fx.example")).toBeNull(); // no model-id
    expect(decodeModelPathSelector("model-id=x")).toBeNull(); // no url
    expect(decodeModelPathSelector("url=a&model-id=b&url=c")).toBeNull(); // duplicate key
    expect(decodeModelPathSelector("url=a&model-id=")).toBeNull(); // empty value
    expect(decodeModelPathSelector("url=a&model-id=%ZZ")).toBeNull(); // bad encoding
    expect(decodeModelPathSelector("url=a&model-id")).toBeNull(); // no separator
  });
});

describe("rankModelPathNodes", () => {
  it("ranks a node on its pinned route, not its cheapest one", () => {
    // Node A is cheapest overall (non-whitelisted decart route) but routes
    // through an expensive pinned route; node B's pinned route is cheaper, so
    // routing would pick B first and the ranking must agree.
    const cheapest = route({
      path: "url=decart&model-id=m",
      pricing: { prompt: 0.0001, completion: 0.0001, request: 0, max_cost: 0 },
    });
    const pinned = route({
      path: "url=deepseek&model-id=m",
      pinned: true,
      pricing: { prompt: 0.0005, completion: 0.0015, request: 0, max_cost: 0 },
    });
    const nodes = rankModelPathNodes([
      { baseUrl: "https://a.example/", routes: [pinned, cheapest], rankCost: null, rankedOnPin: false },
      {
        baseUrl: "https://b.example/",
        routes: [
          route({
            path: "url=deepseek&model-id=m",
            pinned: true,
            pricing: { prompt: 0.0002, completion: 0.0005, request: 0, max_cost: 0 },
          }),
        ],
        rankCost: null,
        rankedOnPin: false,
      },
    ]);

    expect(nodes.map((node) => node.baseUrl)).toEqual([
      "https://b.example/",
      "https://a.example/",
    ]);
    // 100k prompt at a 90% cache hit + 2k completion; no cache rate is
    // advertised here, so prompt bills the whole prompt: 100k*0.0005 +
    // 2k*0.0015 = 53 sats.
    expect(nodes[1]!.rankCost).toBeCloseTo(53, 6);
    expect(nodes[1]!.rankedOnPin).toBe(true);
    // Routes inside a node are cheapest warm-request cost first, pinned or not.
    expect(nodes[1]!.routes.map((entry) => entry.path)).toEqual([
      "url=decart&model-id=m",
      "url=deepseek&model-id=m",
    ]);
  });

  it("falls back to the cheapest route when no pinned route is available", () => {
    const nodes = rankModelPathNodes([
      {
        baseUrl: "https://a.example/",
        routes: [
          route({ path: "url=b", pricing: { prompt: 0, completion: 0.002, request: 0, max_cost: 0 } }),
          route({ path: "url=a", pricing: { prompt: 0, completion: 0.001, request: 0, max_cost: 0 } }),
        ],
        rankCost: null,
        rankedOnPin: false,
      },
    ]);

    expect(nodes[0]!.routes.map((entry) => entry.path)).toEqual(["url=a", "url=b"]);
    // 2k completion tokens at 0.001 sats each; the prompt rate is 0.
    expect(nodes[0]!.rankCost).toBeCloseTo(2, 6);
    expect(nodes[0]!.rankedOnPin).toBe(false);
  });

  it("never ranks a node on a route on cooldown, and sorts unpriced nodes last", () => {
    const nodes = rankModelPathNodes([
      {
        baseUrl: "https://cooled.example/",
        routes: [
          route({
            path: "url=pinned",
            pinned: true,
            onCooldown: true,
            pricing: { prompt: 0, completion: 0.00001, request: 0, max_cost: 0 },
          }),
          route({
            path: "url=other",
            pricing: { prompt: 0, completion: 0.0009, request: 0, max_cost: 0 },
          }),
        ],
        rankCost: null,
        rankedOnPin: false,
      },
      {
        baseUrl: "https://unpriced.example/",
        routes: [route({ path: "url=none", pricing: null, pricingSource: "none" })],
        rankCost: null,
        rankedOnPin: false,
      },
      {
        baseUrl: "https://cheap.example/",
        routes: [
          route({ path: "url=cheap", pricing: { prompt: 0, completion: 0.0005, request: 0, max_cost: 0 } }),
        ],
        rankCost: null,
        rankedOnPin: false,
      },
    ]);

    expect(nodes.map((node) => node.baseUrl)).toEqual([
      "https://cheap.example/",
      "https://cooled.example/",
      "https://unpriced.example/",
    ]);
    expect(nodes[1]!.rankCost).toBeCloseTo(1.8, 6);
    expect(nodes[1]!.rankedOnPin).toBe(false);
    expect(nodes[2]!.rankCost).toBeNull();
  });

  it("ranks on what one warm request costs, not on the completion rate", () => {
    // Identical prompt rates; b has the cheaper completion rate, a the much
    // cheaper cache read. Routing prices 90% of the prompt at the cache rate,
    // so a is the node a warm session would actually be billed less on:
    // a = 10k*0.0002 + 90k*0.000004 + 2k*0.0008 = 3.96 sats
    // b = 10k*0.0002 + 90k*0.00005  + 2k*0.0006 = 7.70 sats
    const nodes = rankModelPathNodes([
      {
        baseUrl: "https://b.example/",
        routes: [
          route({
            path: "url=b",
            pricing: {
              prompt: 0.0002,
              completion: 0.0006,
              request: 0,
              max_cost: 0,
              input_cache_read: 0.00005,
            },
          }),
        ],
        rankCost: null,
        rankedOnPin: false,
      },
      {
        baseUrl: "https://a.example/",
        routes: [
          route({
            path: "url=a",
            pricing: {
              prompt: 0.0002,
              completion: 0.0008,
              request: 0,
              max_cost: 0,
              input_cache_read: 0.000004,
            },
          }),
        ],
        rankCost: null,
        rankedOnPin: false,
      },
    ]);

    expect(nodes.map((node) => node.baseUrl)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
    expect(nodes[0]!.rankCost).toBeCloseTo(3.96, 6);
    expect(nodes[1]!.rankCost).toBeCloseTo(7.7, 6);
  });

  it("orders routes inside a node by warm-request cost", () => {
    // The cheaper completion rate loses to the cheaper cache read + prompt.
    const nodes = rankModelPathNodes([
      {
        baseUrl: "https://a.example/",
        routes: [
          route({
            path: "url=cheap-output",
            pricing: {
              prompt: 0.0004,
              completion: 0.0009,
              request: 0,
              max_cost: 0,
              input_cache_read: 0.00002,
            },
          }),
          route({
            path: "url=cheap-cache",
            pricing: {
              prompt: 0.0001,
              completion: 0.0012,
              request: 0,
              max_cost: 0,
              input_cache_read: 0.000001,
            },
          }),
        ],
        rankCost: null,
        rankedOnPin: false,
      },
    ]);

    expect(nodes[0]!.routes.map((entry) => entry.path)).toEqual([
      "url=cheap-cache",
      "url=cheap-output",
    ]);
    expect(nodes[0]!.routes[0]!.cost).toBeCloseTo(3.49, 6);
    expect(nodes[0]!.routes[1]!.cost).toBeCloseTo(7.6, 6);
  });

  it("never ranks a route whose rates are not prices", () => {
    const nodes = rankModelPathNodes([
      {
        baseUrl: "https://broken.example/",
        routes: [
          route({
            path: "url=negative",
            pricing: {
              prompt: -0.001,
              completion: 0.001,
              request: 0,
              max_cost: 0,
            },
          }),
        ],
        rankCost: null,
        rankedOnPin: false,
      },
      {
        baseUrl: "https://fine.example/",
        routes: [
          route({
            path: "url=fine",
            pricing: { prompt: 0.001, completion: 0.001, request: 0, max_cost: 0 },
          }),
        ],
        rankCost: null,
        rankedOnPin: false,
      },
    ]);

    expect(nodes.map((node) => node.baseUrl)).toEqual([
      "https://fine.example/",
      "https://broken.example/",
    ]);
    expect(nodes[1]!.routes[0]!.cost).toBeNull();
    expect(nodes[1]!.rankCost).toBeNull();
  });

  it("breaks price ties by URL so the order is deterministic", () => {
    const price = { prompt: 0, completion: 0.001, request: 0, max_cost: 0 };
    const nodes = rankModelPathNodes([
      { baseUrl: "https://b.example/", routes: [route({ pricing: price })], rankCost: null, rankedOnPin: false },
      { baseUrl: "https://a.example/", routes: [route({ pricing: price })], rankCost: null, rankedOnPin: false },
    ]);

    expect(nodes.map((node) => node.baseUrl)).toEqual([
      "https://a.example/",
      "https://b.example/",
    ]);
  });
});

describe("formatModelPaths", () => {
  const output: ModelPathsOutput = {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    nodes: rankModelPathNodes([
      {
        baseUrl: "https://ai.redsh1ft.com/",
        routes: [
          route({
            path: "url=https%3A%2F%2Fopenrouter.ai%2Fapi%2Fv1&model-id=deepseek-v4.1-flash&endpoint=deepseek",
            upstream: "https://openrouter.ai/api/v1",
            endpoint: "deepseek",
            pinned: true,
            pricing: {
              prompt: 0.0001882,
              completion: 0.0007527,
              request: 0,
              max_cost: 0,
              input_cache_read: 0.00002,
              input_cache_write: 0.0001,
            },
          }),
          route({
            path: "url=https%3A%2F%2Fapi.venice.ai%2Fapi%2Fv1&model-id=deepseek-v4-1-flash",
            upstream: "https://api.venice.ai/api/v1",
            modelId: "deepseek-v4-1-flash",
            pricing: { prompt: 0.00045235, completion: 0.0018094, request: 0, max_cost: 0 },
          }),
        ],
        rankCost: null,
        rankedOnPin: false,
      },
    ]),
    skipped: [{ baseUrl: "https://legacy.example/", reason: "no model paths advertised" }],
  };

  it("renders the ranked node, its routes and the skipped nodes", () => {
    const text = formatModelPaths(output);
    const lines = text.split("\n");

    expect(lines[0]).toBe("Model paths for deepseek-v4.1-flash (DeepSeek V4.1 Flash)");
    expect(text).toContain("1 node, 2 advertised routes");
    expect(text).toContain("[pin] marks the first route the router pins");
    expect(text).toContain(
      "   1. https://ai.redsh1ft.com/  2 routes  rank 5.19 sats/request (pinned route)",
    );
    expect(text).toContain("cost = sats for the SDK's WARM_COST_BASKET");
    // The sort key is the warm-basket cost of the route (5.19 / 48.85 sats),
    // not its completion rate: the venice route is the pricier of the two on
    // both, and the cache-less route pays prompt rate for all 100k tokens.
    expect(text).toContain(
      "        5.19   188.20  752.70      20.00       100.00       1,000,000  openrouter.ai/api/v1 [deepseek]  [pin]",
    );
    // A route that advertises no cache rate shows "-": 0 / absent is "not
    // announced", not "free".
    expect(text).toContain(
      "        48.85  452.35  1809.40     -           -            1,000,000  api.venice.ai/api/v1  [id deepseek-v4-1-flash]",
    );
    expect(text).toContain("cost   prompt  completion  cache read  cache write");
    expect(text).toContain("api.venice.ai/api/v1");
    // A route reachable only under a variant spelling says so.
    expect(text).toContain("[id deepseek-v4-1-flash]");
    expect(text).toContain("Not shown:");
    expect(text).toContain("    https://legacy.example/  no model paths advertised");
  });

  it("renders an inventory with no nodes", () => {
    expect(formatModelPaths({ id: "gpt-5.6", nodes: [], skipped: [] })).toBe(
      "Model paths for gpt-5.6\n\n  No node advertises model paths for this model.",
    );
  });
});
