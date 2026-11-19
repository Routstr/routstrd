import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { getEncodedToken } from "@cashu/cashu-ts";
import { createDaemonRequestHandler } from "./index";

type Call = "recover" | "flush" | "refundProviders" | "refundXcashuTokens";

const KEYSET = "00cadd580ab9ab9a";

/** A well-formed parked token; the route never contacts its mint here. */
function parkedToken(secret: string, unit: "sat" | "msat" = "sat"): string {
  return getEncodedToken({
    mint: "https://mint.example",
    unit,
    proofs: [
      {
        amount: 2,
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
  flush?: () => Promise<void>;
  includeMalformed?: boolean;
}

async function refund(
  path: "/refund" | "/refund/xcashu" | "/wallet/parked",
  {
    state = { cachedTokens: [], apiKeys: [] },
    receivable = [],
    results = [],
    flush = async () => {},
    includeMalformed = false,
  }: RefundOptions = {},
) {
  const calls: Call[] = [];
  const parkedSecrets = ["parked-1", "parked-2"];
  let parked = parkedSecrets.map((secret, i) => {
    const unit = i === 0 ? "sat" : "msat";
    return { token: parkedToken(secret, unit), amount: 2, unit, createdAt: Date.now() };
  });
  const bearerTokens = parked.map(({ token }) => token);
  const malformed = "cashuB-invalid-do-not-expose";
  if (includeMalformed) {
    parked.push({ token: malformed, amount: 3, unit: "sat", createdAt: Date.now() });
    bearerTokens.push(malformed);
  }

  const receiveToken = mock(async (token: string) => {
    calls.push("recover");
    const index = bearerTokens.indexOf(token);
    if (index >= 0 && receivable.includes(parkedSecrets[index]!)) {
      return { success: true, amount: 2, unit: index === 0 ? "sat" as const : "msat" as const };
    }
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
    flush: async () => {
      calls.push("flush");
      await flush();
    },
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
    method: path === "/wallet/parked" ? "GET" : "POST",
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
  if (req.method === "POST") {
    setImmediate(() => {
      req.emit("data", Buffer.from(JSON.stringify({ mintUrl: "https://mint.example" })));
      req.emit("end");
    });
  }
  await handler(req, res as never);

  return {
    status: res.status,
    output: JSON.parse(res.body).output,
    calls,
    body: res.body,
    bearerTokens,
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
    expect(output.recovered.remaining).toBe(1);
    expect(output.recovered.recoveredFaceValue).toEqual({ sat: 2, msat: 0 });
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
    expect(calls.indexOf("flush")).toBeGreaterThan(0);
    expect(calls.indexOf("flush")).toBeLessThan(calls.indexOf("refundProviders"));
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


describe("wallet parked metadata", () => {
  it("lists amounts by unit without returning bearer tokens or contacting a mint", async () => {
    const { status, output, calls, body, bearerTokens } = await refund("/wallet/parked", {
      includeMalformed: true,
    });
    expect(status).toBe(200);
    expect(output.count).toBe(3);
    expect(output.amounts).toEqual({ sat: 5, msat: 2 });
    expect(output.tokens.every((entry: object) => !("token" in entry))).toBe(true);
    for (const token of bearerTokens) expect(body).not.toContain(token);
    expect(calls).toEqual([]);
  });

  for (const path of ["/refund", "/refund/xcashu"] as const) {
    it(`${path} reports persisted discards without returning token strings`, async () => {
      const { output, body, bearerTokens } = await refund(path, { includeMalformed: true });
      expect(output.recovered.dropped).toEqual([{ reason: "undecodable", amount: 3, unit: "sat" }]);
      for (const token of bearerTokens) expect(body).not.toContain(token);
    });
  }

  it("reports a flush failure without claiming the discard was saved", async () => {
    const { output, body } = await refund("/refund", {
      includeMalformed: true,
      flush: async () => { throw new Error("private storage error"); },
    });
    expect(output.recovered.pruneError).toBeTruthy();
    expect(output.recovered.dropped).toEqual([]);
    expect(body).not.toContain("private storage error");
  });
});
