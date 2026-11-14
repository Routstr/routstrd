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

/**
 * `GET /models` serves two catalogs from one route: the curated routstr21 list
 * (what the CLI lists by default) and, with `all=true`, every model the
 * enabled providers advertise (`routstrd models --all`). The flag has to reach
 * the service, not just change the response shape, or the extra models would
 * never appear.
 */
describe("GET /models", () => {
  const curated = [{ id: "deepseek-v4.1-flash-1017" }];
  const catalog = [...curated, { id: "unlisted-model" }];

  function makeDeps(options: { withAvailable?: boolean } = {}) {
    const calls: Array<{ catalog: "curated" | "all"; forceRefresh?: boolean }> = [];
    const deps: Record<string, unknown> = {
      store: { getState: () => ({}) },
      getRoutstr21Models: async (forceRefresh?: boolean) => {
        calls.push({ catalog: "curated", forceRefresh });
        return curated;
      },
    };
    if (options.withAvailable !== false) {
      deps.getAvailableModels = async (forceRefresh?: boolean) => {
        calls.push({ catalog: "all", forceRefresh });
        return catalog;
      };
    }
    return { handler: createDaemonRequestHandler(deps as any), calls };
  }

  it("returns the curated routstr21 list by default", async () => {
    const { handler, calls } = makeDeps();

    const res = await call(handler, "GET", "/models");

    expect(res.status).toBe(200);
    expect(res.json().output.models).toEqual(curated);
    expect(calls).toEqual([{ catalog: "curated", forceRefresh: false }]);
  });

  it("returns the full catalog with all=true", async () => {
    const { handler, calls } = makeDeps();

    const res = await call(handler, "GET", "/models?all=true");

    expect(res.status).toBe(200);
    expect(res.json().output.models).toEqual(catalog);
    expect(calls).toEqual([{ catalog: "all", forceRefresh: false }]);
  });

  it("requires an explicit true: any other value means the curated list", async () => {
    for (const query of ["?all=false", "?all=1", "?all=", "?al=true"]) {
      const { handler, calls } = makeDeps();
      const res = await call(handler, "GET", `/models${query}`);
      expect(res.json().output.models).toEqual(curated);
      expect(calls).toEqual([{ catalog: "curated", forceRefresh: false }]);
    }
  });

  it("passes refresh through alongside all", async () => {
    const { handler, calls } = makeDeps();

    await call(handler, "GET", "/models?all=true&refresh=true");

    expect(calls).toEqual([{ catalog: "all", forceRefresh: true }]);
  });

  it("falls back to the curated list when the daemon has no catalog view", async () => {
    // An older/embedded caller may inject only the curated reader; the route
    // must still answer rather than 500 on an undefined function.
    const { handler, calls } = makeDeps({ withAvailable: false });

    const res = await call(handler, "GET", "/models?all=true");

    expect(res.status).toBe(200);
    expect(res.json().output.models).toEqual(curated);
    expect(calls).toEqual([{ catalog: "curated", forceRefresh: false }]);
  });
});
