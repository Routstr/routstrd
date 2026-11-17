// Scenario runner for confidential-gate.test.ts (isolated bun process with
// ROUTSTRD_DIR set before module evaluation, like auto-refresh.scenario.ts).
import { createServer, request } from "http";
import type { AddressInfo } from "net";

const { createDaemonRequestHandler } = await import("../../src/daemon/http/index");

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`ASSERT-FAIL: ${msg}`);
    process.exit(1);
  }
}

// Every dependency is an empty stub: a request that reached routing (and so
// could be sent in plaintext) would fail with a 5xx, not the gate's 400.
const stubDeps = {
  provider: null,
  server: { close() {} },
  store: {},
  walletClient: {},
  walletAdapter: {},
  storageAdapter: {},
  discoveryAdapter: {},
  modelManager: {},
  ensureProvidersBootstrapped: async () => {},
  getRoutstr21Models: async () => [],
  getModelProviders: async () => [],
  refreshProvidersAndModels: async () => {},
  mode: "apikeys" as const,
  maxTokens: 64000,
  usageTrackingDriver: {},
  providerManager: {},
  refundClient: {},
};

async function post(
  deps: Record<string, unknown>,
  path: string,
  verify: string = "confidential",
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const server = createServer(createDaemonRequestHandler(deps as never));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-routstr-verify": verify,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "SENTINEL-PROMPT" }],
      }),
    });
    return { status: res.status, body: await res.text() };
  } finally {
    server.close();
  }
}

const enabled = {
  ...stubDeps,
  confidentialUpstream: {
    enabled: true,
    trusted_hosts: ["api.venice.ai"],
    node_pubkeys: [],
    prover_path: "/nonexistent",
  },
};

// Opt-in requested but the feature is off: refused, never routed.
for (const deps of [stubDeps, { ...stubDeps, confidentialUpstream: { enabled: false } }]) {
  const r = await post(deps, "/v1/chat/completions");
  assert(r.status === 400, `disabled: status ${r.status}`);
  assert(r.body.includes("not enabled"), `disabled: body ${r.body}`);
}

// Enabled, but an endpoint the confidential transport does not implement.
for (const path of ["/v1/responses", "/v1/embeddings", "/v1/completions"]) {
  const r = await post(enabled, path);
  assert(r.status === 400, `${path}: status ${r.status}`);
  assert(
    r.body.includes("only POST /v1/chat/completions, /v1/images/generations and /v1/image/generate."),
    `${path}: body ${r.body}`,
  );
}

// Case and surrounding whitespace do not matter for the accepted value: it is
// recognized (and then refused here because the feature is off).
for (const v of ["Confidential", " CONFIDENTIAL\t"]) {
  const r = await post(stubDeps, "/v1/chat/completions", v);
  assert(r.status === 400, `${JSON.stringify(v)}: status ${r.status}`);
  assert(r.body.includes("not enabled"), `${JSON.stringify(v)}: body ${r.body}`);
}

// Any other value is refused, never routed on the plain path, whether or not
// the feature is on.
for (const deps of [stubDeps, enabled]) {
  for (const v of ["confidentail", "confidential, confidential", "confidential;strict", "true", "1", ""]) {
    const r = await post(deps, "/v1/chat/completions", v);
    assert(r.status === 400, `${JSON.stringify(v)}: status ${r.status}`);
    assert(r.body.includes("Unrecognized x-routstr-verify"), `${JSON.stringify(v)}: body ${r.body}`);
  }
}

// Accepted: the request reaches routing with the confidential option set.
// Without it the SDK would send the prompt on the plain path.
{
  const seen: Array<Record<string, unknown>> = [];
  const routed = {
    ...enabled,
    routeRequests: async (options: Record<string, unknown>) => {
      seen.push(options);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  for (const path of ["/v1/chat/completions", "/v1/images/generations", "/v1/image/generate"]) {
    const before = seen.length;
    const r = await post(routed, path);
    assert(r.status === 200, `${path} accepted: status ${r.status}, body ${r.body}`);
    assert(seen.length === before + 1, `${path}: not routed`);
    const confidential = seen.at(-1)?.confidential as { trustedHosts?: string[] } | undefined;
    assert(confidential?.trustedHosts?.[0] === "api.venice.ai", `${path}: routed without the confidential option`);
  }
}

// A reuse scope that is repeated, empty or over 256 bytes is refused before
// routing: running it in the client's wider scope would join conversations
// the caller meant to keep apart.
{
  let routedCount = 0;
  const routed = {
    ...enabled,
    routeRequests: async () => {
      routedCount += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  for (const scope of ["", "a".repeat(257)]) {
    const r = await post(routed, "/v1/chat/completions", "confidential", { "x-routstr-reuse-scope": scope });
    assert(r.status === 400, `reuse scope of ${scope.length} bytes: status ${r.status}, body ${r.body}`);
    assert(r.body.includes("x-routstr-reuse-scope"), `reuse scope of ${scope.length} bytes: body ${r.body}`);
  }
  // Two header lines (fetch would join them into one): raw HTTP.
  const server = createServer(createDaemonRequestHandler(routed as never));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const repeated = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "SENTINEL-PROMPT" }] });
    const rq = request(
      {
        host: "127.0.0.1",
        port: (server.address() as AddressInfo).port,
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "x-routstr-verify": "confidential",
          "x-routstr-reuse-scope": ["conv-1", "conv-2"],
        },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    rq.on("error", reject);
    rq.end(body);
  });
  server.close();
  assert(repeated.status === 400, `repeated reuse scope: status ${repeated.status}, body ${repeated.body}`);
  assert(repeated.body.includes("x-routstr-reuse-scope"), `repeated reuse scope: body ${repeated.body}`);
  assert(routedCount === 0, `a bad reuse scope was routed (${routedCount})`);
  // One value up to 256 bytes runs.
  const ok = await post(routed, "/v1/chat/completions", "confidential", { "x-routstr-reuse-scope": "a".repeat(256) });
  assert(ok.status === 200 && routedCount === 1, `reuse scope of 256 bytes: status ${ok.status}, body ${ok.body}`);
}

// padBucket reaches the SDK option, and the SDK's warnings have a sink.
{
  let confidential: Record<string, unknown> | undefined;
  const r = await post(
    {
      ...enabled,
      confidentialUpstream: { ...enabled.confidentialUpstream, padBucket: 4096 },
      routeRequests: async (options: Record<string, unknown>) => {
        confidential = options.confidential as Record<string, unknown>;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    },
    "/v1/chat/completions",
  );
  assert(r.status === 200, `padBucket: status ${r.status}`);
  assert(confidential?.padBucket === 4096, `padBucket not passed: ${String(confidential?.padBucket)}`);
  assert(typeof confidential?.onWarning === "function", "onWarning not passed");
}

// A node refusal with the node's status 402 keeps it.
{
  const r = await post(
    {
      ...enabled,
      routeRequests: async () => {
        throw Object.assign(new Error("node refused the request: balance (status 402)"), {
          name: "RequestRefusedError",
          code: "request_refused",
          status: 402,
        });
      },
    },
    "/v1/chat/completions",
  );
  assert(r.status === 402, `refused with 402: status ${r.status}, body ${r.body}`);
  assert((JSON.parse(r.body) as { error_type?: string }).error_type === "request_refused", `refused with 402: body ${r.body}`);
}

// A stream that fails before its first byte is an error, not an empty 200.
{
  const r = await post(
    {
      ...enabled,
      routeRequests: async () =>
        new Response(new ReadableStream({ pull(c) { c.error(new Error("reset before the first chunk")); } }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    },
    "/v1/chat/completions",
  ).catch((e: unknown) => ({ status: -1, body: String(e) }));
  assert(r.status === 502, `stream failed before its first byte: status ${r.status}, body ${JSON.stringify(r.body)}`);
  assert(r.body.includes("upstream_unavailable"), `stream failed before its first byte: body ${r.body}`);
}

// A stream that fails after its first byte (a settlement check that failed
// after the text) ends the client's connection without a clean end, so a
// client never reads it as a complete answer.
{
  const r = await post(
    {
      ...enabled,
      routeRequests: async () => {
        let sent = false;
        return new Response(
          new ReadableStream({
            async pull(c) {
              if (!sent) {
                sent = true;
                c.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
              c.error(new Error("receipt check failed"));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    },
    "/v1/chat/completions",
  ).catch((e: unknown) => ({ status: -1, body: String(e) }));
  assert(r.status === -1, `stream failed after its first byte ended cleanly: status ${r.status}, body ${JSON.stringify(r.body)}`);
}

// No node serves the model confidentially (routed or pinned): the caller's
// error, 400 no_confidential_provider with the SDK's message.
for (const message of [
  "No provider offers model m confidentially",
  "Provider http://127.0.0.1:9/ does not offer model m confidentially",
]) {
  const r = await post(
    {
      ...enabled,
      routeRequests: async () => {
        throw Object.assign(new Error(message), { name: "ConfidentialError", code: "no_confidential_provider" });
      },
    },
    "/v1/chat/completions",
  );
  assert(r.status === 400, `no confidential provider: status ${r.status}, body ${r.body}`);
  const body = JSON.parse(r.body) as { error?: string; error_type?: string };
  assert(body.error_type === "no_confidential_provider", `no confidential provider: body ${r.body}`);
  assert(body.error === message, `no confidential provider: body ${r.body}`);
}

// The same through the SDK's own routing: a node lists the model, but not
// confidentially (routed, and pinned with x-routstr-provider).
{
  const NODE = "http://127.0.0.1:9/";
  const model = { id: "m", name: "m", sats_pricing: { prompt: 1, completion: 1, max_cost: 10 } };
  const sdkDeps = {
    ...enabled,
    walletAdapter: { getBalances: async () => ({}) },
    discoveryAdapter: {
      getModelPathWhitelist: () => ({}),
      getModelIdMappings: () => null,
      getDisabledProviders: () => [],
      getCachedMints: () => ({}),
    },
    modelManager: {
      getBaseUrls: () => [NODE],
      getAllCachedModels: () => ({ [NODE]: [model] }),
    },
    providerManager: {
      getProviderPriceRankingForModel: () => [{ baseUrl: NODE, model }],
      getModelPathProviderRanking: async () => [],
    },
  };
  for (const [pin, message] of [
    [undefined, "No provider offers model m confidentially"],
    [NODE, `Provider ${NODE} does not offer model m confidentially`],
  ] as const) {
    const r = await post(sdkDeps, "/v1/chat/completions", "confidential", pin ? { "x-routstr-provider": pin } : {});
    assert(r.status === 400, `SDK, pin ${pin}: status ${r.status}, body ${r.body}`);
    const body = JSON.parse(r.body) as { error?: string; error_type?: string };
    assert(body.error_type === "no_confidential_provider", `SDK, pin ${pin}: body ${r.body}`);
    assert(body.error === message, `SDK, pin ${pin}: body ${r.body}`);
  }
}

console.log("SCENARIO-OK");
