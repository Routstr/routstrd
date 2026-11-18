import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { createDaemonRequestHandler } from "./index";

function makeReq(path: string, body?: unknown) {
  const req = new EventEmitter() as any;
  req.method = "POST";
  req.url = path;
  req.headers = { host: "localhost", "content-type": "application/json" };
  setImmediate(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  return {
    status: 0,
    body: "",
    writeHead(status: number) {
      this.status = status;
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk;
    },
  };
}

describe("offline Cashu send HTTP API", () => {
  it("returns token value and operation metadata for offline sends", async () => {
    const sendCashuOffline = mock(async () => ({
      token: "cashu-token",
      operationId: "op-1",
      mintUrl: "https://mint.example",
      requestedAmount: 1020,
      actualAmount: 1024,
      overpayment: 4,
      state: "pending",
    }));
    const sendCashu = mock(async () => "online-token");
    const handler = createDaemonRequestHandler({
      walletClient: { sendCashuOffline, sendCashu },
    } as never);
    const res = makeRes();

    await handler(
      makeReq("/wallet/send/cashu", { amount: 1020, offline: true }),
      res as never,
    );

    expect(res.status).toBe(200);
    expect(sendCashuOffline).toHaveBeenCalledWith(1020, undefined, undefined);
    expect(sendCashu).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).output).toMatchObject({
      operationId: "op-1",
      actualAmount: 1024,
      overpayment: 4,
      state: "pending",
    });
  });

  it("preserves the existing online response when offline is absent or false", async () => {
    const sendCashu = mock(async () => "online-token");
    const sendCashuOffline = mock(async () => { throw new Error("unused"); });
    const handler = createDaemonRequestHandler({
      walletClient: { sendCashuOffline, sendCashu },
    } as never);
    const res = makeRes();

    await handler(
      makeReq("/wallet/send/cashu", { amount: 64, offline: false }),
      res as never,
    );

    expect(res.status).toBe(200);
    expect(sendCashu).toHaveBeenCalledWith(64, undefined);
    expect(sendCashuOffline).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).output).toEqual({
      token: "online-token",
      amount: 64,
    });
  });

  it("forwards a valid overpay cap to the offline send", async () => {
    const sendCashuOffline = mock(async () => ({
      token: "cashu-token",
      operationId: "op-1",
      mintUrl: "https://mint.example",
      requestedAmount: 100,
      actualAmount: 100,
      overpayment: 0,
      state: "pending",
      mode: "online",
      overpayCap: 3,
    }));
    const handler = createDaemonRequestHandler({
      walletClient: { sendCashuOffline, sendCashu: mock(async () => "online-token") },
    } as never);
    const res = makeRes();

    await handler(
      makeReq("/wallet/send/cashu", { amount: 100, offline: true, overpayCap: 3 }),
      res as never,
    );

    expect(res.status).toBe(200);
    expect(sendCashuOffline).toHaveBeenCalledWith(100, undefined, {
      overpayCap: 3,
    });
    expect(JSON.parse(res.body).output.mode).toBe("online");
  });

  it("rejects invalid or non-offline overpay caps", async () => {
    const sendCashu = mock(async () => "online-token");
    const sendCashuOffline = mock(async () => { throw new Error("unused"); });
    const handler = createDaemonRequestHandler({
      walletClient: { sendCashuOffline, sendCashu },
    } as never);

    for (const overpayCap of [0, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = makeRes();
      await handler(
        makeReq("/wallet/send/cashu", {
          amount: 100,
          offline: true,
          overpayCap,
        }),
        res as never,
      );
      expect(res.status).toBe(400);
    }

    const withoutOffline = makeRes();
    await handler(
      makeReq("/wallet/send/cashu", { amount: 100, overpayCap: 3 }),
      withoutOffline as never,
    );
    expect(withoutOffline.status).toBe(400);
    expect(sendCashu).not.toHaveBeenCalled();
    expect(sendCashuOffline).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean offline flag", async () => {
    const sendCashu = mock(async () => "online-token");
    const handler = createDaemonRequestHandler({
      walletClient: { sendCashu },
    } as never);
    const res = makeRes();

    await handler(
      makeReq("/wallet/send/cashu", { amount: 64, offline: "yes" }),
      res as never,
    );

    expect(res.status).toBe(400);
    expect(sendCashu).not.toHaveBeenCalled();
  });

  it("marks a selected operation spent without a mint-check parameter", async () => {
    const markSendSpent = mock(async () => ({
      operationId: "op-1",
      state: "finalized",
      markedSpent: 2,
      actualAmount: 1024,
    }));
    const handler = createDaemonRequestHandler({
      walletClient: { markSendSpent },
    } as never);
    const res = makeRes();

    await handler(
      makeReq("/wallet/send/cashu/op-1/mark-spent"),
      res as never,
    );

    expect(res.status).toBe(200);
    expect(markSendSpent).toHaveBeenCalledWith("op-1");
    expect(JSON.parse(res.body).output).toMatchObject({
      operationId: "op-1",
      state: "finalized",
      markedSpent: 2,
    });
  });
});
