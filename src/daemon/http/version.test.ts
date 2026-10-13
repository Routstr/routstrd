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

async function callVersion(state: UpdateState | null, enabled = true) {
  const handler = createDaemonRequestHandler({
    loadUpdateState: () => state,
    updateChecksEnabled: () => enabled,
  } as any);
  const res = makeRes();
  await handler(makeReq("GET", "/version"), res);
  return res;
}

const behind: UpdateState = {
  current: VERSION,
  latest: "0.5.0",
  hasUpdate: true,
  checkedAt: new Date().toISOString(),
};

describe("GET /version", () => {
  it("returns the cached update state alongside the running version", async () => {
    const res = await callVersion(behind);
    expect(res.status).toBe(200);
    expect(res.json().output).toEqual({
      version: VERSION,
      current: VERSION,
      latest: "0.5.0",
      hasUpdate: true,
      checkedAt: behind.checkedAt,
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
  it("does not advertise stale, mismatched, invalid or already installed updates", async () => {
    for (const state of [
      { ...behind, checkedAt: "2020-01-01T00:00:00.000Z" },
      { ...behind, current: "0.1.0" },
      { ...behind, latest: VERSION },
      { ...behind, latest: "invalid" },
    ]) {
      const res = await callVersion(state);
      expect(res.json().output.hasUpdate).toBe(false);
      expect(res.json().output.current).toBe(VERSION);
      expect(res.json().output.checkedAt).toBe(state.checkedAt);
    }
  });

  it("suppresses cached updates when disabled in config", async () => {
    const res = await callVersion(behind, false);
    expect(res.json().output.hasUpdate).toBe(false);
  });

});
