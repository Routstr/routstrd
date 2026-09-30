import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, chmodSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { join } from "path";
import { LightningPayments, type StorageAdapter, type LightningInvoice } from "@routstr/sdk";
import { CONFIG_DIR } from "../../utils/config";

/** Invoice IDs/BOLT11s are bearer recovery credentials. Store with wallet-level permissions. */
export class LightningInvoiceJournal {
  constructor(private readonly directory = join(CONFIG_DIR, "lightning-invoices")) {}

  save(baseUrl: string, purpose: string, invoice: LightningInvoice): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const path = this.path(baseUrl, invoice.invoice_id);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ baseUrl, purpose, ...invoice }), { mode: 0o600 });
    renameSync(temp, path);
  }

  list(): unknown[] {
    // Loaded only by an explicit operator command; never log recovery credentials.
    try {
      return readdirSync(this.directory).filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(this.directory, name), "utf8")));
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  private path(baseUrl: string, invoiceId: string): string {
    return join(this.directory, `${createHash("sha256").update(`${baseUrl}:${invoiceId}`).digest("hex")}.json`);
  }
}

function stringField(body: Record<string, unknown>, field: string): string {
  if (typeof body[field] !== "string" || !body[field].trim()) throw new Error(`${field} is required`);
  return body[field];
}

export async function executeLightningOperation(
  action: string,
  body: Record<string, unknown>,
  storage: StorageAdapter,
  payments = new LightningPayments(),
  journal = new LightningInvoiceJournal(),
): Promise<unknown> {
  if (action === "invoices") return journal.list();
  const url = new URL(stringField(body, "baseUrl"));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid provider URL");
  const baseUrl = `${url.href.replace(/\/$/, "")}/`;
  if (action === "create" || action === "topup") {
    if (action === "create" && storage.getApiKey(baseUrl)) throw new Error("Provider already has a stored key; use topup");
    const key = action === "topup" ? storage.getApiKey(baseUrl)?.key : undefined;
    if (action === "topup" && !key) throw new Error("No stored provider key");
    const invoice = await payments.createInvoice({ baseUrl, purpose: action, amountSats: body.amountSats as number, apiKey: key });
    try {
      journal.save(baseUrl, action, invoice);
    } catch {
      // The remote quote exists even if local persistence fails. Return its recovery credentials.
      return { ...invoice, warning: "Invoice journal write failed; save this invoice ID and BOLT11 before paying." };
    }
    return invoice;
  }
  if (action === "status" || action === "recover") {
    const status = action === "status"
      ? await payments.getInvoiceStatus(baseUrl, stringField(body, "invoiceId"))
      : await payments.recoverInvoice(baseUrl, stringField(body, "bolt11"));
    if (status.status === "paid") await payments.acceptPaidInvoice(baseUrl, status, storage);
    return status;
  }
  if (action === "refund") {
    const key = storage.getApiKey(baseUrl)?.key;
    if (!key) throw new Error("No stored provider key");
    const refund = await payments.refundToLightning(baseUrl, key, stringField(body, "lightningAddress"));
    // A concurrent top-up may have added balance since the refund began. Do not blindly zero it.
    if (refund.status === "paid" && storage.getApiKey(baseUrl)?.key === key) {
      try {
        await payments.refreshKeyBalance(baseUrl, key, storage);
      } catch {
        // The payout has succeeded even if the follow-up balance request fails.
        return { ...refund, warning: "Refund paid; local balance refresh failed. Key retained for recovery." };
      }
    }
    // Keep the key even on success so repeated requests can recover the provider's refund claim.
    return refund;
  }
  throw new Error("Unknown Lightning operation");
}
