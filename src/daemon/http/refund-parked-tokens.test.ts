import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { createDaemonRequestHandler } from "./index";

type Call = "recover" | "refundProviders" | "refundXcashuTokens";

/**
 * Drive one of the manual refund routes against a fake spender, recording the
 * order in which the route touches the SDK.
 */
interface RefundOptions {
  state?: { cachedTokens?: unknown[]; apiKeys?: unknown[] };
  parked?: Array<{ token: string; success: boolean }>;
  results?: unknown[];
}

async function refund(
  path: "/refund" | "/refund/xcashu",
  {
    state = { cachedTokens: [], apiKeys: [] },
    parked = [],
    results = [],
  }: RefundOptions = {},
) {
  const calls: Call[] = [];
  const recoverCachedReceiveTokens = mock(async () => {
    calls.push("recover");
    return parked;
  });
  const refundProviders = mock(async () => {
    calls.push("refundProviders");
    return results;
  });
  const refundXcashuTokens = mock(async () => {
    calls.push("refundXcashuTokens");
    return results;
  });

  const handler = createDaemonRequestHandler({
    store: { getState: () => state },
    refundClient: {
      getCashuSpender: () => ({
        recoverCachedReceiveTokens,
        refundProviders,
        refundXcashuTokens,
      }),
    },
  } as never);

  const req = new EventEmitter() as any;
  Object.assign(req, {
    method: "POST",
    url: path,
    headers: { host: "localhost", "content-type": "application/json" },
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
  setImmediate(() => {
    req.emit("data", Buffer.from(JSON.stringify({ mintUrl: "https://mint.example" })));
    req.emit("end");
  });
  await handler(req, res as never);

  return {
    status: res.status,
    output: JSON.parse(res.body).output,
    calls,
    recoverCachedReceiveTokens,
  };
}

describe("manual refund routes recover parked tokens", () => {
  it("POST /refund recovers parked tokens before reporting nothing pending", async () => {
    const { status, output, calls } = await refund("/refund", {
      parked: [
        { token: "parked-1", success: true },
        { token: "parked-2", success: false },
      ],
    });

    expect(status).toBe(200);
    expect(calls).toEqual(["recover"]);
    expect(output.message).toBe("No pending tokens to refund");
    expect(output.recovered).toEqual({ attempted: 2, succeeded: 1 });
  });

  it("POST /refund recovers parked tokens before refunding providers", async () => {
    const { output, calls } = await refund("/refund", {
      state: { cachedTokens: [], apiKeys: [{ baseUrl: "https://provider.example" }] },
      parked: [{ token: "parked-1", success: true }],
      results: [{ baseUrl: "https://provider.example", success: true }],
    });

    expect(calls).toEqual(["recover", "refundProviders"]);
    expect(output.recovered).toEqual({ attempted: 1, succeeded: 1 });
    expect(output.results).toEqual([
      { baseUrl: "https://provider.example", success: true },
    ]);
  });

  it("POST /refund/xcashu recovers parked tokens too", async () => {
    const { output, calls } = await refund("/refund/xcashu", {
      parked: [{ token: "parked-1", success: true }],
    });

    expect(calls).toEqual(["recover", "refundXcashuTokens"]);
    expect(output.recovered).toEqual({ attempted: 1, succeeded: 1 });
  });
});
