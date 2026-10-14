import { describe, expect, it } from "bun:test";
import { Readable } from "stream";
import { createDaemonRequestHandler } from "./index";
import type { MintRemovalInfo } from "../wallet/wallet-client";

const MINT_URL = "https://mint.example/";

function makeInfo(overrides: Partial<MintRemovalInfo> = {}): MintRemovalInfo {
  return {
    url: MINT_URL,
    spendable: 0,
    reserved: 0,
    total: 0,
    pendingMintQuotes: 0,
    pendingMeltQuotes: 0,
    isDefault: false,
    mintCount: 2,
    hasAssets: false,
    ...overrides,
  };
}

function makeWalletClient(overrides: Record<string, unknown> = {}) {
  const calls: { removed: string[] } = { removed: [] };
  return {
    calls,
    client: {
      listMints: async () => [MINT_URL, "https://mint.other/"],
      getDefaultMint: async () => MINT_URL,
      addMint: async (url: string) => `Mint ${url} added successfully`,
      getMintRemovalInfo: async (url: string) => makeInfo({ url }),
      removeMint: async (url: string) => {
        calls.removed.push(url);
        return `Mint ${url} removed from the wallet`;
      },
      ...overrides,
    },
  };
}

function makeReq(method: string, path: string, body?: unknown) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = payload
    ? (Readable.from([payload]) as any)
    : (Readable.from([]) as any);
  req.method = method;
  req.url = path;
  req.headers = { host: "localhost", "content-type": "application/json" };
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

async function call(
  method: string,
  path: string,
  client: unknown,
  body?: unknown,
) {
  const handler = createDaemonRequestHandler({
    walletClient: client,
  } as any);
  const res = makeRes();
  await handler(makeReq(method, path, body), res);
  return res;
}

describe("GET /wallet/mints/removal-info", () => {
  it("returns the removal info for the requested mint", async () => {
    const { client } = makeWalletClient();
    const res = await call(
      "GET",
      `/wallet/mints/removal-info?url=${encodeURIComponent(MINT_URL)}`,
      client,
    );

    expect(res.status).toBe(200);
    const output = res.json().output as MintRemovalInfo;
    expect(output.url).toBe(MINT_URL);
    expect(output.hasAssets).toBe(false);
  });

  it("rejects a request with no url", async () => {
    const { client } = makeWalletClient();
    const res = await call("GET", "/wallet/mints/removal-info", client);

    expect(res.status).toBe(400);
    expect(String(res.json().error)).toContain("url");
  });
});

describe("DELETE /wallet/mints", () => {
  it("removes the mint and returns the daemon message", async () => {
    const { client, calls } = makeWalletClient();
    const res = await call("DELETE", "/wallet/mints", client, { url: MINT_URL });

    expect(res.status).toBe(200);
    expect(calls.removed).toEqual([MINT_URL]);
    expect(res.json().output.message).toContain("removed");
  });

  it("rejects a request with no url", async () => {
    const { client, calls } = makeWalletClient();
    const res = await call("DELETE", "/wallet/mints", client, {});

    expect(res.status).toBe(400);
    expect(calls.removed).toEqual([]);
  });

  it("surfaces a backend refusal as an error response", async () => {
    const { client } = makeWalletClient({
      removeMint: async () => {
        throw new Error("Cannot remove the last mint in the wallet");
      },
    });
    const res = await call("DELETE", "/wallet/mints", client, { url: MINT_URL });

    expect(res.status).toBe(500);
    expect(String(res.json().error)).toContain("last mint");
  });
});
