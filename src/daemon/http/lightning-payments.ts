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

/** A malformed or out-of-state request; answered with 4xx instead of 500. */
export class LightningRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "LightningRequestError";
  }
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new LightningRequestError(`${field} is required`);
  return value;
}

function parseProviderUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LightningRequestError("Invalid provider URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new LightningRequestError("Invalid provider URL");
  }
  return `${url.href.replace(/\/$/, "")}/`;
}

/**
 * Invoice status responses carry the spend-capable provider key. The daemon
 * stores it; callers only need to know a key was imported, so never echo it.
 */
function redactInvoiceStatus<T extends { api_key?: unknown }>(status: T): T {
  if (typeof status.api_key !== "string" || !status.api_key) return status;
  const key = status.api_key;
  return { ...status, api_key: `${key.slice(0, 6)}…${key.slice(-4)}`, api_key_stored: true };
}

/** Whole sats still on the key after a paid Lightning refund (the provider's fee reserve). */
function remainingSats(refund: unknown): number {
  const raw = (refund as { remaining_msats?: unknown }).remaining_msats;
  const msats = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(msats) && msats > 0 ? Math.floor(msats / 1000) : 0;
}

export async function executeLightningOperation(
  action: string,
  body: Record<string, unknown>,
  storage: StorageAdapter,
  payments = new LightningPayments(),
  journal = new LightningInvoiceJournal(),
): Promise<unknown> {
  if (action === "invoices") return journal.list();
  const baseUrl = parseProviderUrl(stringField(body, "baseUrl"));
  if (action === "create" || action === "topup") {
    if (action === "create" && storage.getApiKey(baseUrl)) throw new LightningRequestError("Provider already has a stored key; use topup", 409);
    const key = action === "topup" ? storage.getApiKey(baseUrl)?.key : undefined;
    if (action === "topup" && !key) throw new LightningRequestError("No stored provider key", 404);
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
    return redactInvoiceStatus(status);
  }
  if (action === "refund") {
    const key = storage.getApiKey(baseUrl)?.key;
    const lightningAddress = stringField(body, "lightningAddress");
    if (!key) throw new LightningRequestError("No stored provider key", 404);
    const refund = await payments.refundToLightning(baseUrl, key, lightningAddress);
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
    // The provider holds back a Lightning fee reserve; a repeat refund replays the same claim
    // rather than paying it out, so point the operator at the Cashu sweep.
    const leftover = refund.status === "paid" ? remainingSats(refund) : 0;
    if (leftover > 0) {
      return {
        ...refund,
        remaining_sats: leftover,
        note: `Provider kept ${leftover} sat(s) as a fee reserve on the key. Sweep it to the local wallet with: routstrd balance --delete-api-keys ${baseUrl}`,
      };
    }
    return refund;
  }
  throw new LightningRequestError("Unknown Lightning operation", 404);
}
