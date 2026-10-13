import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { createDaemonRequestHandler } from "./index";

function get(path: string, walletClient: unknown) {
  const handler = createDaemonRequestHandler({ walletClient } as never);
  const req = new EventEmitter() as any;
  Object.assign(req, {
    method: "GET",
    url: path,
    headers: { host: "localhost" },
  });
  const res = {
    status: 0,
    body: "",
    writeHead(status: number) {
      this.status = status;
    },
    end(chunk: string) {
      this.body = chunk;
    },
  };
  setImmediate(() => req.emit("end"));
  return handler(req, res as never).then(() => res);
}

describe("GET /wallet/doctor", () => {
  it("returns the client's doctor report", async () => {
    const report = {
      generatedAt: 1_800_000_000_000,
      mints: [{ mintUrl: "https://mint.example", reachable: true, latencyMs: 12 }],
      unpaidQuotes: [],
      paidUnissued: [],
      stuckMelts: [],
      uncheckedQuotes: 0,
    };
    const diagnoseWallet = mock(async () => report);
    const res = await get("/wallet/doctor", { diagnoseWallet });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ output: report });
    expect(diagnoseWallet).toHaveBeenCalledTimes(1);
  });

  it("returns 501 when the wallet client has no doctor support", async () => {
    const res = await get("/wallet/doctor", {});
    expect(res.status).toBe(501);
    expect(JSON.parse(res.body).error).toContain("not supported");
  });

  it("surfaces client failures as errors, not a fake-healthy report", async () => {
    const diagnoseWallet = mock(async () => {
      throw new Error("coco repositories unavailable");
    });
    const res = await get("/wallet/doctor", { diagnoseWallet });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toContain(
      "coco repositories unavailable",
    );
  });
});
