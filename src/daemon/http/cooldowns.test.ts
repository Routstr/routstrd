import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import { createDaemonRequestHandler } from "./index";

const PROVIDER_A = "https://provider-a.example/";
const PROVIDER_B = "https://provider-b.example/";
const WINDOW_MS = 210 * 1000;

function makeReq(method: string, path: string, body?: unknown) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = { host: "localhost" };
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

/** Store mirror plus fake SDK ProviderManager (real clearing methods). */
function makeDeps(entries: Array<Record<string, unknown>> = []) {
  const state: any = {
    providersOnCooldown: [...entries],
    lastFailed: {},
    failedProviders: [] as string[],
  };
  const store = { getState: () => state };
  const calls = { clearCooldowns: 0, clearFailureHistory: 0, resetFailedProviders: 0 };
  const providerManager = {
    getCooldownDurationMs: () => WINDOW_MS,
    clearCooldowns: () => {
      calls.clearCooldowns++;
      state.providersOnCooldown = [];
    },
    clearFailureHistory: () => {
      calls.clearFailureHistory++;
      state.lastFailed = {};
    },
    resetFailedProviders: () => {
      calls.resetFailedProviders++;
      state.failedProviders = [];
    },
  };
  const handler = createDaemonRequestHandler({
    store,
    providerManager,
  } as any);
  return { handler, store, state, providerManager, calls };
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

describe("GET /cooldowns", () => {
  it("reports only active entries and their scope", async () => {
    const now = Date.now();
    const { handler } = makeDeps([
      { baseUrl: PROVIDER_A, timestamp: now - 1_000 },
      { baseUrl: PROVIDER_B, modelId: "kimi-k3", timestamp: now - 5_000 },
      { baseUrl: "https://expired.example/", timestamp: now - WINDOW_MS },
    ]);

    const res = await call(handler, "GET", "/cooldowns");
    expect(res.status).toBe(200);
    const output = res.json().output;
    expect(output.count).toBe(2);
    expect(output.providerCount).toBe(2);
    expect(output.cooldowns.map((c: any) => c.scope)).toEqual([
      "provider",
      "model",
    ]);
  });
});

describe("POST /cooldowns/reset", () => {
  it("clears cooldowns and failure state, reporting what was active", async () => {
    const now = Date.now();
    const { handler, state, calls } = makeDeps([
      { baseUrl: PROVIDER_A, timestamp: now - 1_000 },
      { baseUrl: PROVIDER_B, modelId: "kimi-k3", timestamp: now - 5_000 },
      { baseUrl: "https://expired.example/", timestamp: now - WINDOW_MS },
    ]);
    state.lastFailed = { [PROVIDER_A]: now };
    state.failedProviders = [PROVIDER_A];

    const res = await call(handler, "POST", "/cooldowns/reset", {});
    expect(res.status).toBe(200);
    const output = res.json().output;
    expect(output.cleared).toBe(2);
    expect(output.providers).toEqual([PROVIDER_A, PROVIDER_B]);
    expect(output.message).toBe("Reset 2 cooldowns across 2 providers");

    expect(calls).toEqual({
      clearCooldowns: 1,
      clearFailureHistory: 1,
      resetFailedProviders: 1,
    });
    expect(state.providersOnCooldown).toEqual([]);
    expect(state.lastFailed).toEqual({});
    expect(state.failedProviders).toEqual([]);

    // A follow-up read is empty now.
    const after = await call(handler, "GET", "/cooldowns");
    expect(after.json().output.count).toBe(0);
  });

  it("reports nothing to clear when no cooldown is active", async () => {
    const { handler } = makeDeps([
      { baseUrl: PROVIDER_A, timestamp: Date.now() - WINDOW_MS },
    ]);

    const res = await call(handler, "POST", "/cooldowns/reset", {});
    expect(res.status).toBe(200);
    expect(res.json().output).toEqual({
      message: "No active cooldowns to reset.",
      cleared: 0,
      providers: [],
    });
  });
});
