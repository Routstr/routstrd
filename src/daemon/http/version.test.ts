import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import { createDaemonRequestHandler } from "./index";
import type { UpdateState } from "../../utils/update-state";
import { VERSION } from "../../version";

function makeReq(method: string, path: string) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = { host: "localhost" };
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

async function callVersion(state: UpdateState | null) {
  const handler = createDaemonRequestHandler({
    loadUpdateState: () => state,
  } as any);
  const res = makeRes();
  await handler(makeReq("GET", "/version"), res);
  return res;
}

const behind: UpdateState = {
  current: "0.4.14",
  latest: "0.5.0",
  hasUpdate: true,
  checkedAt: "2026-01-02T03:04:05.000Z",
};

describe("GET /version", () => {
  it("returns the cached update state alongside the running version", async () => {
    const res = await callVersion(behind);
    expect(res.status).toBe(200);
    expect(res.json().output).toEqual({
      version: VERSION,
      current: "0.4.14",
      latest: "0.5.0",
      hasUpdate: true,
      checkedAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("reports no update when the cache is empty", async () => {
    const res = await callVersion(null);
    expect(res.status).toBe(200);
    expect(res.json().output).toEqual({
      version: VERSION,
      current: VERSION,
      latest: null,
      hasUpdate: false,
      checkedAt: null,
    });
  });
});
