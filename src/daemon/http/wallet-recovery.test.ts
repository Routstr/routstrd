import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { createDaemonRequestHandler } from "./index";

async function recover(body: unknown) {
  const recoverMintQuotes = mock(async (_options: unknown) => ({ recovered: 0 }));
  const handler = createDaemonRequestHandler({ walletClient: { recoverMintQuotes } } as never);
  const req = new EventEmitter() as any;
  Object.assign(req, { method: "POST", url: "/wallet/recover", headers: { host: "localhost" } });
  const res = {
    status: 0, body: "",
    writeHead(status: number) { this.status = status; },
    end(chunk: string) { this.body = chunk; },
  };
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  await handler(req, res as never);
  return { res, recoverMintQuotes };
}

describe("POST /wallet/recover validation", () => {
  it.each([{}, { operationIds: [] }])("rejects includeFailed without explicit IDs: %j", async (body) => {
    const { res, recoverMintQuotes } = await recover({ ...body, includeFailed: true });
    expect(res.status).toBe(400);
    expect(recoverMintQuotes).not.toHaveBeenCalled();
  });
  it.each([[""], ["  "], [42]])("rejects invalid operation IDs: %j", async (operationIds) => {
    const { res, recoverMintQuotes } = await recover({ operationIds });
    expect(res.status).toBe(400);
    expect(recoverMintQuotes).not.toHaveBeenCalled();
  });
  it.each([0, -1, "1000"])("rejects invalid timeout %j", async (timeoutMs) => {
    const { res, recoverMintQuotes } = await recover({ timeoutMs });
    expect(res.status).toBe(400);
    expect(recoverMintQuotes).not.toHaveBeenCalled();
  });
  it("passes normalized explicit IDs and a positive timeout", async () => {
    const { res, recoverMintQuotes } = await recover({ operationIds: [" op-1 "], includeFailed: true, timeoutMs: 1000 });
    expect(res.status).toBe(200);
    expect(recoverMintQuotes).toHaveBeenCalledWith({ operationIds: ["op-1"], includeFailed: true, timeoutMs: 1000 });
  });
  it("still permits checking pending quotes without IDs", async () => {
    const { res, recoverMintQuotes } = await recover({});
    expect(res.status).toBe(200);
    expect(recoverMintQuotes).toHaveBeenCalledTimes(1);
  });
});
