import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import { createDaemonRequestHandler } from "./index";
import { corsHeadersFor } from "./cors";

const resources: Server[] = [];
afterEach(async () => {
  for (const server of resources.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function fixture() {
  const server = createServer(createDaemonRequestHandler({
    store: { getState: () => ({ clientIds: [] }) },
    getRoutstr21Models: async () => [{ id: "deepseek-v4.1-flash-1017" }],
    getModelProviders: async () => ({}),
    getModelPaths: async () => ({}),
    walletAdapter: { getBalances: async () => ({ sat: 1 }), getActiveMintUrl: () => "https://mint.test" },
    ensureProvidersBootstrapped: async () => undefined,
    maxTokens: 1024,
  } as any));
  resources.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}${path}`, init);
}

const PAJA = "http://127.0.0.1:8490";

describe("cors allowlist", () => {
  it("exposes only model listing to loopback pages", () => {
    expect(corsHeadersFor("GET", "/v1/models", PAJA)).toMatchObject({
      "access-control-allow-origin": PAJA,
      vary: "origin",
    });
    expect(corsHeadersFor("OPTIONS", "/v1/models", PAJA)).not.toBeNull();
  });

  it("accepts HTTP loopback spellings, with and without ports", () => {
    for (const origin of ["http://localhost", "http://localhost:8490", "http://127.0.0.1", "http://[::1]", "http://[::1]:8490"]) {
      expect(corsHeadersFor("GET", "/v1/models", origin)?.["access-control-allow-origin"]).toBe(origin);
    }
  });

  it("rejects TLS, null, and lookalike origins", () => {
    for (const origin of ["https://localhost", "https://127.0.0.1", "https://[::1]", "null", "http://localhost.evil.example", "http://127.0.0.1.evil.example", "http://localhost@evil.example"]) {
      expect(corsHeadersFor("GET", "/v1/models", origin)).toBeNull();
    }
  });

  it("never exposes CLI and wallet surfaces", () => {
    for (const path of ["/wallet/balance", "/wallet/send", "/settings/auto-refresh", "/tokens", "/clients", "/keys/api", "/stop", "/requests/abc", "/v1/chat/completions"]) {
      expect(corsHeadersFor("GET", path, PAJA)).toBeNull();
      expect(corsHeadersFor("POST", path, PAJA)).toBeNull();
      expect(corsHeadersFor("OPTIONS", path, PAJA)).toBeNull();
    }
  });

  it("ignores hosted origins and non-reading methods", () => {
    expect(corsHeadersFor("GET", "/v1/models", "https://evil.example")).toBeNull();
    expect(corsHeadersFor("GET", "/v1/models", undefined)).toBeNull();
    expect(corsHeadersFor("POST", "/v1/models", PAJA)).toBeNull();
  });
});

describe("cors over the wire", () => {
  it("answers the preflight and marks the model list readable", async () => {
    const call = await fixture();
    const preflight = await call("/v1/models", {
      method: "OPTIONS",
      headers: { origin: PAJA, "access-control-request-method": "GET" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(PAJA);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
    const listed = await call("/v1/models", { headers: { origin: PAJA } });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("access-control-allow-origin")).toBe(PAJA);
  });

  it("uses canonical model paths for GET, HEAD, and preflight", async () => {
    const call = await fixture();
    for (const path of ["/v1/models", "/v1/v1/models"]) {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        const response = await call(path, {
          method,
          headers: { origin: PAJA, ...(method === "OPTIONS" ? { "access-control-request-method": "HEAD" } : {}) },
        });
        expect(response.status).toBe(method === "OPTIONS" ? 204 : 200);
        expect(response.headers.get("access-control-allow-origin")).toBe(PAJA);
        expect(response.headers.get("vary")).toBe("origin");
        if (method !== "GET") expect(await response.text()).toBe("");
      }
    }
  });

  it("varies model responses even for denied or absent origins", async () => {
    const call = await fixture();
    for (const path of ["/v1/models", "/v1/v1/models"]) {
      for (const origin of [undefined, "https://evil.example"]) {
        const response = await call(path, { headers: origin ? { origin } : {} });
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(response.headers.get("vary")).toBe("origin");
      }
    }
  });

  it("leaves wallet reads and their preflights unreadable to a page", async () => {
    const call = await fixture();
    const balance = await call("/wallet/balance", { headers: { origin: PAJA } });
    expect(balance.status).toBe(200);
    expect(balance.headers.get("access-control-allow-origin")).toBeNull();
    expect(balance.headers.get("vary")).toBeNull();
    const preflight = await call("/wallet/balance", {
      method: "OPTIONS",
      headers: { origin: PAJA, "access-control-request-method": "GET" },
    });
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not hand a hosted origin the model list", async () => {
    const call = await fixture();
    const response = await call("/v1/models", { headers: { origin: "https://evil.example" } });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
