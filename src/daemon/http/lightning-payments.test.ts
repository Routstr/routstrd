import { EventEmitter } from "events";
import { createDaemonRequestHandler } from "./index";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LightningPayments, type StorageAdapter } from "@routstr/sdk";
import { executeLightningOperation, LightningInvoiceJournal } from "./lightning-payments";

const dirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "routstr-lightning-test-"));
  dirs.push(dir);
  const journal = new LightningInvoiceJournal(join(dir, "invoices"));
  let key: string | undefined;
  let balance = 0;
  const storage = {
    getApiKey: () => key ? { key, balance } : null,
    setApiKey: (_url: string, value: string) => { key = value; },
    updateApiKeyBalance: (_url: string, value: number) => { balance = value; },
  } as unknown as StorageAdapter;
  return { journal, storage, dir };
}

describe("paired SDK/provider Lightning lifecycle", () => {
  it("journals invoices, imports only paid keys, tops up and refunds without losing the key", async () => {
    const { journal, storage, dir } = setup();
    let paid = false;
    let providerBalance = 100000;
    let purpose = "create";
    const server = Bun.serve({ port: 0, fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v2/lightning/invoice") {
        const body = await req.json() as any;
        purpose = body.purpose;
        if (purpose === "topup") expect(req.headers.get("authorization")).toBe("Bearer sk-test");
        else expect(req.headers.has("authorization")).toBe(false);
        return Response.json({ invoice_id: purpose, bolt11: `lnbc-${purpose}`, amount_sats: 100, payment_hash: "quote", expires_at: 1000 });
      }
      if (path.includes("/status") || path === "/v2/lightning/recover") return Response.json({ status: paid ? "paid" : "pending", api_key: paid ? "sk-test" : null, amount_sats: 100, created_at: 1, expires_at: 1000 });
      if (path === "/v1/wallet/info") return Response.json({ balance: providerBalance, reserved: 0 });
      if (path === "/v1/wallet/refund") {
        expect((await req.json() as any).lightning_address).toBe("alice@example.com");
        providerBalance = 5000; // A concurrent top-up: the client must refresh, not blindly zero balance.
        return Response.json({ refund_id: "refund-1", status: "paid", recipient: "alice@example.com", sats: "100" });
      }
      return new Response(null, { status: 404 });
    } });
    servers.push(server);
    const baseUrl = `http://localhost:${server.port}/`;
    const payments = new LightningPayments();
    const run = (action: string, body: Record<string, unknown>) => executeLightningOperation(action, { baseUrl, ...body }, storage, payments, journal);
    await run("create", { amountSats: 100 });
    expect(journal.list()).toHaveLength(1);
    const path = join(dir, "invoices", readdirSync(join(dir, "invoices"))[0]!);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "invoices")).mode & 0o777).toBe(0o700);
    await run("status", { invoiceId: "create" });
    expect(storage.getApiKey(baseUrl)).toBeNull();
    paid = true;
    await run("status", { invoiceId: "create" });
    expect(storage.getApiKey(baseUrl)?.key).toBe("sk-test");
    expect(storage.getApiKey(baseUrl)?.balance).toBe(100);
    await expect(run("create", { amountSats: 100 })).rejects.toThrow("already");
    await run("topup", { amountSats: 100 });
    providerBalance = 200000;
    await run("recover", { bolt11: "lnbc-topup" });
    expect(storage.getApiKey(baseUrl)?.balance).toBe(200);
    await run("refund", { lightningAddress: "alice@example.com" });
    expect(storage.getApiKey(baseUrl)?.key).toBe("sk-test");
    expect(storage.getApiKey(baseUrl)?.balance).toBe(5);
    expect(new LightningInvoiceJournal(join(dir, "invoices")).list()).toHaveLength(2);
  });

  it("retains the stored key and snapshot after an ambiguous refund", async () => {
    const { journal, storage } = setup();
    const baseUrl = "https://provider.example/";
    storage.setApiKey(baseUrl, "sk-test");
    storage.updateApiKeyBalance(baseUrl, 100, 0);
    const payments = new LightningPayments((async () => Response.json({ detail: { error: { code: "refund_unresolved" } } }, { status: 409 })) as unknown as typeof fetch);
    await expect(executeLightningOperation("refund", { baseUrl, lightningAddress: "alice@example.com" }, storage, payments, journal)).rejects.toMatchObject({ status: 409 });
    expect(storage.getApiKey(baseUrl)?.balance).toBe(100);
    expect(storage.getApiKey(baseUrl)?.key).toBe("sk-test");
  });
});


describe("HTTP refund recovery", () => {
  it("retains credentials when delete-key refund fails", async () => {
    let removed = false;
    const handler = createDaemonRequestHandler({
      storageAdapter: { getApiKey: () => ({ baseUrl: "https://provider.example/", key: "sk-test" }), removeApiKey: () => { removed = true; } },
      refundClient: { getBalanceManager: () => ({ refundApiKey: async () => ({ success: false, message: "Refund unresolved" }) }) },
    } as any);
    const req = new EventEmitter() as any;
    req.method = "DELETE";
    req.url = "/keys/api/delete?baseUrl=https%3A%2F%2Fprovider.example%2F&mintUrl=https%3A%2F%2Fmint.example";
    req.headers = { host: "localhost" };
    let status = 0;
    let body = "";
    const res = { writeHead: (code: number) => { status = code; }, end: (chunk: string) => { body = chunk; } } as any;
    await handler(req, res);
    expect(status).toBe(409);
    expect(removed).toBe(false);
    expect(JSON.parse(body).output.removed).toBe(false);
  });

  it("routes journal listing through the daemon HTTP handler", async () => {
    const handler = createDaemonRequestHandler({} as any);
    const req = new EventEmitter() as any;
    req.method = "POST";
    req.url = "/payments/lightning/invoices";
    req.headers = { host: "localhost" };
    let status = 0;
    let body = "";
    const res = { writeHead: (code: number) => { status = code; }, end: (chunk: string) => { body = chunk; } } as any;
    const request = handler(req, res);
    req.emit("data", "{}");
    req.emit("end");
    await request;
    expect(status).toBe(200);
    expect(Array.isArray(JSON.parse(body).output)).toBe(true);
  });
});
