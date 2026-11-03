import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { createDaemonRequestHandler } from "./index";

async function request(body: unknown, supported = true) {
  const sweep = mock(async () => ({ candidates: 2, claimed: 1, reclaimed: 0, failed: 1 }));
  const handler = createDaemonRequestHandler({ walletClient: supported ? { sweepOfflineSends: sweep } : {} } as never);
  const req = new EventEmitter() as any;
  req.method = "POST";
  req.url = "/wallet/sweep-offline";
  req.headers = { host: "localhost" };
  const res = { status: 0, body: "", writeHead(status: number) { this.status = status; }, end(chunk?: string) { this.body += chunk ?? ""; } };
  setImmediate(() => { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); });
  await handler(req, res as never);
  return { ...res, sweep };
}

describe("offline sweep API", () => {
  it("requires explicit confirmation for a destructive sweep", async () => {
    for (const body of [{}, { confirmed: false }, { confirmed: "yes" }, { dryRun: "true" }]) {
      const result = await request(body);
      expect(result.status).toBe(400);
      expect(result.sweep).not.toHaveBeenCalled();
    }
  });
  it("allows local previews without confirmation", async () => {
    const result = await request({ dryRun: true });
    expect(result.status).toBe(200);
    expect(result.sweep).toHaveBeenCalledWith({ dryRun: true, confirmed: false, minAgeMs: undefined, mintUrl: undefined });
  });
  it("passes confirmed options and reports partial failures", async () => {
    const result = await request({ confirmed: true, minAgeMs: 123, mintUrl: "https://mint.example" });
    expect(result.status).toBe(200);
    expect(result.sweep).toHaveBeenCalledWith({ confirmed: true, dryRun: false, minAgeMs: 123, mintUrl: "https://mint.example" });
    expect(JSON.parse(result.body).output).toMatchObject({ claimed: 1, reclaimed: 0, failed: 1 });
  });
  it("rejects malformed ages and unsupported wallet clients", async () => {
    for (const minAgeMs of [-1, 0.1, "168", Number.MAX_SAFE_INTEGER + 1]) {
      const result = await request({ confirmed: true, minAgeMs });
      expect(result.status).toBe(400);
      expect(result.sweep).not.toHaveBeenCalled();
    }
    expect((await request({ dryRun: true }, false)).status).toBe(501);
  });
});
