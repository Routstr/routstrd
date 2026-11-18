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

async function call(handler: Function, method: string, path: string) {
  const res = makeRes();
  await handler(makeReq(method, path), res);
  return res;
}

describe("GET /models/:id/providers", () => {
  function makeDeps(output: unknown) {
    const calls: Array<{ modelId: string; includeDisabled?: boolean }> = [];
    const handler = createDaemonRequestHandler({
      store: { getState: () => ({}) },
      getModelProviders: async (modelId: string, includeDisabled?: boolean) => {
        calls.push({ modelId, includeDisabled });
        return output;
      },
    } as any);
    return { handler, calls };
  }

  it("hides disabled nodes by default", async () => {
    const payload = {
      id: "deepseek-v4.1-flash-1017",
      providers: [{ baseUrl: "https://on.example/", disabled: false }],
      hiddenProviders: 1,
    };
    const { handler, calls } = makeDeps(payload);

    const res = await call(
      handler,
      "GET",
      "/models/deepseek-v4.1-flash-1017/providers",
    );

    expect(res.status).toBe(200);
    expect(res.json().output).toEqual(payload);
    expect(calls).toEqual([
      { modelId: "deepseek-v4.1-flash-1017", includeDisabled: false },
    ]);
  });

  it("forwards includeDisabled=true for --all", async () => {
    const { handler, calls } = makeDeps({
      id: "m",
      providers: [],
      hiddenProviders: 0,
    });

    const res = await call(
      handler,
      "GET",
      "/models/m/providers?includeDisabled=true",
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ modelId: "m", includeDisabled: true }]);
  });

  it("keeps includeDisabled off for anything but a literal true", async () => {
    const { handler, calls } = makeDeps({ id: "m", providers: [] });

    await call(handler, "GET", "/models/m/providers?includeDisabled=1");
    await call(handler, "GET", "/models/m/providers?includeDisabled=false");

    expect(calls.map((entry) => entry.includeDisabled)).toEqual([false, false]);
  });

  it("serves a model whose nodes are all disabled instead of 404ing", async () => {
    // Empty provider list, not null: the model exists, routing just has no
    // node for it, and the CLI says so.
    const payload = {
      id: "deepseek-v4.1-flash-1017",
      providers: [],
      hiddenProviders: 2,
    };
    const { handler } = makeDeps(payload);

    const res = await call(
      handler,
      "GET",
      "/models/deepseek-v4.1-flash-1017/providers",
    );

    expect(res.status).toBe(200);
    expect(res.json().output).toEqual(payload);
  });

  it("decodes the model id and 404s for a model nobody serves", async () => {
    const { handler, calls } = makeDeps(null);

    const res = await call(handler, "GET", "/models/glm-5.3%2Fflash/providers");

    expect(res.status).toBe(404);
    expect(res.json().error).toBe("Model 'glm-5.3/flash' not found");
    expect(calls).toEqual([
      { modelId: "glm-5.3/flash", includeDisabled: false },
    ]);
  });
});
