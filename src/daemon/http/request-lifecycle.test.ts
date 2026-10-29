import { afterEach, describe, expect, it } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginRequestLifecycle, type RequestLifecycleDriver } from "@routstr/sdk";
import { createBunSqliteRequestLifecycleDriver } from "@routstr/sdk/bun";
import { createMemoryUsageTrackingDriver } from "@routstr/sdk/storage";
import { createDaemonRequestHandler } from "./index";

const resources: Array<{ server: Server; dir: string }> = [];
afterEach(async () => {
  for (const { server, dir } of resources.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "routstrd-lifecycle-http-"));
  const driver = await createBunSqliteRequestLifecycleDriver({ dbPath: join(dir, "test.db") });
  await driver.migrate();
  const server = createServer(createDaemonRequestHandler({
    requestLifecycleDriver: driver,
    lifecycleOwnerInstanceId: "test-daemon",
    store: { getState: () => ({ clientIds: [{ clientId: "alice", name: "Alice", apiKey: "sk-test-client" }] }) },
    usageTrackingDriver: createMemoryUsageTrackingDriver(),
    getRoutstr21Models: async () => [],
    walletAdapter: { getBalances: async () => ({}), getActiveMintUrl: () => undefined },
    ensureProvidersBootstrapped: async () => { throw new Error("Provider discovery unavailable"); },
    maxTokens: 1024,
    ...overrides,
  } as any));
  resources.push({ server, dir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  return { driver, server, base, call: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init) };
}

async function seed(driver: RequestLifecycleDriver, clientId: string, modelId: string, status: number) {
  const lifecycle = await beginRequestLifecycle({ driver, method: "POST", path: "/v1/chat/completions", clientId, modelId });
  await lifecycle.finish({ outcome: status === 200 ? "succeeded" : "failed", httpStatus: status });
  return lifecycle.requestId;
}

describe("inference ingress lifecycle", () => {
  it.each([
    ["Bearer", { authorization: "Bearer sk-test-client" }],
    ["x-api-key", { "x-api-key": "sk-test-client" }],
  ])("attributes malformed failures with %s before usage exists", async (_kind, headers) => {
    const { call, driver } = await fixture();
    const response = await call("/v1/chat/completions", { method: "POST", headers, body: "{broken" });
    expect(response.status).toBe(400);
    const id = response.headers.get("x-routstr-sdk-request-id");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const trace = await driver.getTrace(id!);
    expect(trace?.request.clientId).toBe("alice");
    expect(trace?.request.outcome).toBe("failed");
    expect(trace?.request.httpStatus).toBe(400);
    expect(trace?.attempts).toEqual([]);
    expect(trace?.request.endedAt).toBeNumber();
  });

  it.each(["{}", "null", "[]", '"text"'])("finalizes missing model body %s with unknown attribution", async (body) => {
    const { call, driver } = await fixture();
    const response = await call("/v1/embeddings", { method: "POST", body });
    expect(response.status).toBe(400);
    const trace = await driver.getTrace(response.headers.get("x-routstr-sdk-request-id")!);
    expect(trace?.request.clientId).toBe("unknown");
    expect(trace?.request.outcome).toBe("failed");
    expect(trace?.request.httpStatus).toBe(400);
  });

  it("does not accept caller IDs as primary IDs or persist credentials/prompt in validation traces", async () => {
    const { call, driver } = await fixture();
    const response = await call("/v1/messages", {
      method: "POST", headers: { authorization: "Bearer sk-test-client", "x-request-id": "caller-id" },
      body: JSON.stringify({ messages: [{ content: "PRIVATE PROMPT" }] }),
    });
    const id = response.headers.get("x-routstr-sdk-request-id")!;
    expect(id).not.toBe("caller-id");
    const trace = await driver.getTrace(id);
    expect(trace?.request.callerRequestId).toBe("caller-id");
    expect(JSON.stringify(trace)).not.toContain("sk-test-client");
    expect(JSON.stringify(trace)).not.toContain("PRIVATE PROMPT");
  });

  it("finalizes local preparation failure and retains canonical requested model", async () => {
    const { call, driver } = await fixture();
    const response = await call("/v1/chat/completions", {
      method: "POST", headers: { "x-api-key": "sk-test-client" }, body: JSON.stringify({ model: "deepseek-v4.1-flash" }),
    });
    expect(response.status).toBe(500);
    const trace = await driver.getTrace(response.headers.get("x-routstr-sdk-request-id")!);
    expect(trace?.request.clientId).toBe("alice");
    expect(trace?.request.requestedModelId).toBe("deepseek-v4.1-flash");
    expect(trace?.request.outcome).toBe("failed");
    expect(trace?.attempts).toEqual([]);
  });

  it("marks client disconnect during local preparation as aborted", async () => {
    let entered!: () => void;
    const enteredPreparation = new Promise<void>((resolve) => { entered = resolve; });
    const preparationReleased = new Promise<never>(() => {});
    const { base, driver, server } = await fixture({ ensureProvidersBootstrapped: async () => {
      entered();
      await preparationReleased;
    } });
    const serverClosed = new Promise<void>((resolve) => server.once("request", (_req, res) => res.once("close", resolve)));
    const request = httpRequest(`${base}/v1/chat/completions`, { method: "POST", headers: { "x-api-key": "sk-test-client" } });
    request.on("error", () => {});
    request.end(JSON.stringify({ model: "deepseek-v4.1-flash" }));
    await enteredPreparation;
    request.destroy();
    // Wait for the server to observe socket close before allowing preparation to fail.
    await serverClosed;
    let outcome: string | undefined;
    for (let i = 0; i < 100; i++) {
      outcome = (await driver.list())[0]?.outcome;
      if (outcome === "aborted") break;
      await Bun.sleep(5);
    }
    expect(outcome).toBe("aborted");
    const row = (await driver.list())[0]!;
    expect(row.clientId).toBe("alice");
    expect(row.endedAt).toBeNumber();
  });

  it("never creates rows for health, models, wallet or rejected admin calls", async () => {
    const { call, driver } = await fixture();
    for (const path of ["/health", "/models", "/wallet/balance", "/clients"]) {
      const response = await call(path);
      await response.text();
      expect(response.headers.get("x-routstr-sdk-request-id")).toBeNull();
    }
    for (const path of ["/balance", "/discovery", "/admin"]) {
      const response = await call(path, { method: "POST", body: "{}" });
      await response.text();
      expect(response.headers.get("x-routstr-sdk-request-id")).toBeNull();
    }
    const admin = await call("/clients/delete", { method: "POST", body: "{}" });
    expect(admin.status).toBe(400);
    expect(admin.headers.get("x-routstr-sdk-request-id")).toBeNull();
    expect(await driver.list()).toEqual([]);
  });
});

describe("lifecycle query endpoints", () => {
  it("lists with client/model/outcome filters and returns full detail and 404", async () => {
    const { call, driver } = await fixture();
    const alice = await seed(driver, "alice", "deepseek-v4.1-flash", 400);
    await seed(driver, "bob", "other-model", 200);
    const response = await call("/requests?clientId=alice&modelId=deepseek-v4.1-flash&outcome=failed&limit=1");
    expect(response.status).toBe(200);
    const list = await response.json() as any;
    expect(list.output.map((entry: any) => entry.requestId)).toEqual([alice]);
    const detail = await (await call(`/requests/${alice}`)).json() as any;
    expect(detail.request.requestId).toBe(alice);
    expect(detail.attempts).toEqual([]);
    expect(Array.isArray(detail.events)).toBe(true);
    const sequences = detail.events.map((event: any) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect((await call("/requests/not-found")).status).toBe(404);
    expect((await call("/requests?outcome=invalid")).status).toBe(400);
    expect((await call("/requests?after=not-a-time")).status).toBe(400);
  });

  it("applies before/after bounds", async () => {
    const { call, driver } = await fixture();
    const id = await seed(driver, "alice", "model", 400);
    const trace = await driver.getTrace(id);
    const timestamp = trace!.request.startedAt;
    expect((await (await call(`/requests?after=${timestamp - 1}&before=${timestamp + 1}`)).json() as any).output).toHaveLength(1);
    expect((await (await call(`/requests?after=${timestamp + 1}`)).json() as any).output).toEqual([]);
  });
});

describe("/usagePi upstream response compatibility", () => {
  it("matches new upstreamResponseId and legacy requestId, not lifecycle UUID or unrelated entries", async () => {
    const usage = createMemoryUsageTrackingDriver([
      ...[
        { id: "legacy", requestId: "gen-123-legacy" },
        { id: "new", requestId: "11111111-2222-4333-8444-555555555555", upstreamResponseId: "gen-123-new" },
        { id: "other", requestId: "gen-456-other" },
        { id: "prefer-upstream", requestId: "gen-123-old", upstreamResponseId: "gen-456-new" },
      ].map((entry) => ({ ...entry, timestamp: Date.now(), modelId: "model", baseUrl: "https://provider.example", cost: 0, satsCost: 2, promptTokens: 1, completionTokens: 1, totalTokens: 2 })),
    ]);
    const { call } = await fixture({ usageTrackingDriver: usage });
    const response = await call("/usagePi?timestamp=123");
    expect(response.status).toBe(200);
    const json = await response.json() as any;
    expect(json.output.entries.map((entry: any) => entry.id).sort()).toEqual(["legacy", "new"]);
    expect(json.output.totalEntries).toBe(2);
    expect(json.output.totalSatsCost).toBe(4);
  });
});

/** Uses the real SDK resolver/client/transport; adapters supply local state only. */
async function routedFixture(mode: "success" | "passthrough" | "stream") {
  const upstream = createServer((req, res) => {
    if (req.url === "/v1/wallet/info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ balance: 100000, reserved: 0, api_key: "sk-node-key" }));
      return;
    }
    req.resume();
    res.setHeader("x-routstr-request-id", "node-attempt-id");
    if (mode === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"gen-stream","choices":[{"delta":{"content":"hello"}}]}\n\n');
    } else if (mode === "passthrough") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_parameter", message: "Invalid parameter" } }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "gen-node-response", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const node = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/`;
  const model = { id: "model", name: "model", pricing: { prompt: "0", completion: "0" } };
  const discoveryAdapter = {
    getCachedMints: () => ({ [node]: ["https://mint.example"] }),
    getDisabledProviders: () => [], getModelIdMappings: () => ({}),
  };
  const storageAdapter = {
    getApiKey: () => ({ key: "sk-node-key", balance: 100, reserved: 0 }),
    getApiKeyDistribution: () => [{ baseUrl: node, amount: 100, reserved: 0 }],
    flush: async () => {}, updateApiKeyBalance() {}, touchApiKeyLastUsed() {},
  };
  const providerManager = {
    getModelForProvider: async () => model, getRequiredSatsForModel: () => 1,
    recordSuccess() {}, markFailed() {},
    getFailedProviders: () => new Set(),
  };
  const daemon = await fixture({
    provider: node, mode: "apikeys", ensureProvidersBootstrapped: async () => {},
    modelManager: { getBaseUrls: () => [node], getAllCachedModels: () => ({ [node]: [model] }) },
    discoveryAdapter, storageAdapter, providerManager,
    walletAdapter: { getBalances: async () => ({ "https://mint.example": 100 }), getActiveMintUrl: () => "https://mint.example" },
  });
  return { ...daemon, closeUpstream: async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  } };
}

async function awaitTerminal(driver: RequestLifecycleDriver, id: string) {
  for (let i = 0; i < 200; i++) {
    const trace = await driver.getTrace(id);
    if (trace?.request.outcome !== "in_progress") return trace;
    await Bun.sleep(5);
  }
  return driver.getTrace(id);
}

describe("real SDK routed responses", () => {
  it.each(["success", "passthrough"] as const)("preserves node header beside full SDK header on %s", async (mode) => {
    const { call, driver, closeUpstream } = await routedFixture(mode);
    try {
      const response = await call("/v1/chat/completions", {
        method: "POST", headers: { "x-api-key": "sk-test-client" },
        body: JSON.stringify({ model: "model", messages: [] }),
      });
      const body = await response.json() as any;
      expect(response.status).toBe(mode === "success" ? 200 : 400);
      expect(response.headers.get("x-routstr-request-id")).toBe("node-attempt-id");
      const id = response.headers.get("x-routstr-sdk-request-id")!;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(id).not.toBe("node-attempt-id");
      const trace = await awaitTerminal(driver, id);
      expect(trace?.request.clientId).toBe("alice");
      expect(trace?.request.outcome).toBe(mode === "success" ? "succeeded" : "failed");
      expect(trace?.attempts.map((a) => [a.ordinal, a.httpStatus, a.nodeRequestId])).toEqual([[1, mode === "success" ? 200 : 400, "node-attempt-id"]]);
      if (mode === "success") expect(body.id).toBe("gen-node-response");
      else expect(body.error).toBeDefined();
    } finally { await closeUpstream(); }
  });

  it("aborts the SDK lifecycle when the downstream disconnects after SSE headers", async () => {
    const { base, driver, closeUpstream } = await routedFixture("stream");
    try {
      const id = await new Promise<string>((resolve, reject) => {
        const request = httpRequest(`${base}/v1/chat/completions`, { method: "POST", headers: { "x-api-key": "sk-test-client" } }, (response) => {
          expect(response.statusCode).toBe(200);
          expect(response.headers["x-routstr-request-id"]).toBe("node-attempt-id");
          response.once("data", () => {
            resolve(response.headers["x-routstr-sdk-request-id"] as string);
            response.destroy(); request.destroy();
          });
          response.on("error", () => {});
        });
        request.on("error", reject);
        request.end(JSON.stringify({ model: "model", messages: [], stream: true }));
      });
      const trace = await awaitTerminal(driver, id);
      expect(trace?.request.outcome).toBe("aborted");
      expect(trace?.request.clientId).toBe("alice");
      expect(trace?.attempts).toHaveLength(1);
      expect(trace?.attempts[0]?.httpStatus).toBe(200);
      expect(trace?.events.filter((event) => event.type === "request_finished")).toHaveLength(1);
    } finally { await closeUpstream(); }
  });
});
