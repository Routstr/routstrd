import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { getEncodedToken } from "@cashu/cashu-ts";
import { createDaemonRequestHandler } from "./index";

type Call = "recover" | "refundProviders" | "refundXcashuTokens";

const KEYSET = "00cadd580ab9ab9a";

/** A well-formed parked token; the route never contacts its mint here. */
function parkedToken(secret: string): string {
  return getEncodedToken({
    mint: "https://mint.example",
    unit: "sat",
    proofs: [
      {
        amount: 1,
        id: KEYSET,
        secret,
        C: `02${createHash("sha256").update(secret).digest("hex")}`,
      },
    ],
  } as never);
}

/**
 * Drive one of the manual refund routes against a fake spender, recording the
 * order in which the route touches the SDK.
 */
interface RefundOptions {
  state?: { cachedTokens?: unknown[]; apiKeys?: unknown[] };
  /** Receives for these secrets succeed; everything else fails as sub-fee dust. */
  receivable?: string[];
  results?: unknown[];
}

async function refund(
  path: "/refund" | "/refund/xcashu",
  {
    state = { cachedTokens: [], apiKeys: [] },
    receivable = [],
    results = [],
  }: RefundOptions = {},
) {
  const calls: Call[] = [];
  const parkedSecrets = ["parked-1", "parked-2"];
  let parked = parkedSecrets.map((secret) => ({
    token: parkedToken(secret),
    amount: 1,
    unit: "sat" as const,
    createdAt: Date.now(),
  }));

  const receiveToken = mock(async (token: string) => {
    calls.push("recover");
    // Only the tokens whose secret is listed are received; everything else
    // fails the way sub-fee dust does. A merged token is never produced here
    // because these fixtures are single-proof and share one mint.
    const received = parkedSecrets.some(
      (secret) => receivable.includes(secret) && token === parkedToken(secret),
    );
    if (received) return { success: true, amount: 1, unit: "sat" as const };
    return {
      success: false,
      amount: 0,
      unit: "sat" as const,
      message: "Receive amount is not sufficient after fees",
    };
  });

  const refundProviders = mock(async () => {
    calls.push("refundProviders");
    return results;
  });
  const refundXcashuTokens = mock(async () => {
    calls.push("refundXcashuTokens");
    return results;
  });

  const storageAdapter = {
    getCachedReceiveTokens: () => parked,
    setCachedReceiveTokens: (next: typeof parked) => {
      parked = next;
    },
  };

  const handler = createDaemonRequestHandler({
    store: { getState: () => state },
    storageAdapter,
    refundClient: {
      getCashuSpender: () => ({
        receiveToken,
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
    parked: () => parked,
  };
}

describe("manual refund routes recover parked tokens", () => {
  it("POST /refund recovers parked tokens before reporting nothing pending", async () => {
    const { status, output, calls } = await refund("/refund", {
      receivable: ["parked-1"],
    });

    expect(status).toBe(200);
    expect(calls).toContain("recover");
    expect(output.message).toBe("No pending tokens to refund");
    expect(output.recovered.parked).toBe(2);
    expect(output.recovered.succeeded).toBe(1);
  });

  it("POST /refund recovers parked tokens before refunding providers", async () => {
    const { output, calls } = await refund("/refund", {
      state: { cachedTokens: [], apiKeys: [{ baseUrl: "https://provider.example" }] },
      receivable: ["parked-1"],
      results: [{ baseUrl: "https://provider.example", success: true }],
    });

    // Recovery runs before the provider refund, in that order.
    expect(calls[0]).toBe("recover");
    expect(calls).toContain("refundProviders");
    expect(output.recovered.succeeded).toBe(1);
    expect(output.results).toEqual([
      { baseUrl: "https://provider.example", success: true },
    ]);
  });

  it("POST /refund/xcashu recovers parked tokens too", async () => {
    const { output, calls } = await refund("/refund/xcashu", {
      receivable: ["parked-1"],
    });

    expect(calls[0]).toBe("recover");
    expect(calls).toContain("refundXcashuTokens");
    expect(output.recovered.succeeded).toBe(1);
  });
});
