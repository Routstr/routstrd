import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import { createDaemonRequestHandler } from "./index";

function makeReq(method: string, path: string) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = { host: "localhost" };
  setImmediate(() => req.emit("end"));
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

async function call(
  handler: Function,
  method: string,
  path: string,
) {
  const res = makeRes();
  await handler(makeReq(method, path), res);
  return res;
}

describe("GET /models/:id/paths", () => {
  function makeDeps(modelPaths: unknown) {
    const calls: Array<{
      modelId: string;
      refresh?: boolean;
      includeDisabled?: boolean;
    }> = [];
    const handler = createDaemonRequestHandler({
      store: { getState: () => ({}) },
      getModelPaths: async (
        modelId: string,
        refresh?: boolean,
        includeDisabled?: boolean,
      ) => {
        calls.push({ modelId, refresh, includeDisabled });
        return modelPaths;
      },
    } as any);
    return { handler, calls };
  }

  it("returns the inventory as the daemon built it (already ranked)", async () => {
    const inventory = {
      id: "deepseek-v4.1-flash",
      nodes: [{ baseUrl: "https://a.example/", routes: [], rankCompletion: 1, rankedOnPin: true }],
      skipped: [],
    };
    const { handler, calls } = makeDeps(inventory);

    const res = await call(handler, "GET", "/models/deepseek-v4.1-flash/paths");

    expect(res.status).toBe(200);
    expect(res.json().output).toEqual(inventory);
    expect(calls).toEqual([
      { modelId: "deepseek-v4.1-flash", refresh: false, includeDisabled: false },
    ]);
  });

  it("forwards refresh=true so the SDK's cached path payloads are dropped", async () => {
    const { handler, calls } = makeDeps({ id: "m", nodes: [], skipped: [] });

    const res = await call(handler, "GET", "/models/m/paths?refresh=true");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { modelId: "m", refresh: true, includeDisabled: false },
    ]);
  });

  it("forwards includeDisabled=true so the disabled nodes are listed too", async () => {
    const { handler, calls } = makeDeps({ id: "m", nodes: [], skipped: [] });

    const res = await call(handler, "GET", "/models/m/paths?includeDisabled=true");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { modelId: "m", refresh: false, includeDisabled: true },
    ]);
  });

  it("composes includeDisabled with refresh", async () => {
    const { handler, calls } = makeDeps({ id: "m", nodes: [], skipped: [] });

    const res = await call(
      handler,
      "GET",
      "/models/m/paths?refresh=true&includeDisabled=true",
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { modelId: "m", refresh: true, includeDisabled: true },
    ]);
  });

  it("keeps includeDisabled off for anything but a literal true", async () => {
    const { handler, calls } = makeDeps({ id: "m", nodes: [], skipped: [] });

    await call(handler, "GET", "/models/m/paths?includeDisabled=1");
    await call(handler, "GET", "/models/m/paths?includeDisabled=false");

    expect(calls.map((entry) => entry.includeDisabled)).toEqual([false, false]);
  });

  it("decodes the model id and 404s for an unknown model", async () => {
    const { handler, calls } = makeDeps(null);

    const res = await call(handler, "GET", "/models/glm-5.3%2Fflash/paths");

    expect(res.status).toBe(404);
    expect(res.json().error).toBe("Model 'glm-5.3/flash' not found");
    expect(calls).toEqual([
      { modelId: "glm-5.3/flash", refresh: false, includeDisabled: false },
    ]);
  });
});
