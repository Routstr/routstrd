// Scenario runner for confidential-gate.test.ts (isolated bun process with
// ROUTSTRD_DIR set before module evaluation, like auto-refresh.scenario.ts).
import { createServer } from "http";
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
): Promise<{ status: number; body: string }> {
  const server = createServer(createDaemonRequestHandler(deps as never));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-routstr-verify": "confidential",
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
  assert(r.body.includes("only POST /v1/chat/completions"), `${path}: body ${r.body}`);
}

console.log("SCENARIO-OK");
