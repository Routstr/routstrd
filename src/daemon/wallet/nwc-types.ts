// NIP-47 Nostr Wallet Connect types

/** Parsed NWC connection string */
export interface NwcConnectionString {
  pubkey: string;      // hex pubkey of the wallet service
  relay: string;       // WebSocket relay URL
  secret: string;      // 32-byte hex connection secret (wallet private key)
}

/** NIP-47 request method names */
export type NwcMethod =
  | "pay_invoice"
  | "get_balance"
  | "make_invoice"
  | "lookup_invoice"
  | "get_info"
  | "list_transactions"
  | "sign_message";

/** NIP-47 request event content (kind 23194, encrypted) */
export interface NwcRequest {
  method: NwcMethod;
  params: Record<string, unknown>;
}

/** NIP-47 response event content (kind 23195, encrypted) */
export interface NwcResponse {
  result_type: NwcMethod;
  result?: Record<string, unknown>;
  error?: NwcError;
}

/** NIP-47 error structure */
export interface NwcError {
  code: string;
  message: string;
}

/** Raw Nostr event shape used for relay communication */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Filter for relay subscriptions */
export interface NostrFilter {
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  limit?: number;
  [key: `#${string}`]: string[];
}

// NIP-47 event kinds
export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;

/** Balance result from get_balance */
export interface GetBalanceResult {
  balance: number; // in msats
}

/** Pay invoice result */
export interface PayInvoiceResult {
  preimage: string;
  fees_paid?: number;
}

/** Make invoice params and result */
export interface MakeInvoiceParams {
  amount: number;      // msats
  description?: string;
  description_hash?: string;
  expiry?: number;
}

export interface MakeInvoiceResult {
  invoice: string;
  payment_hash: string;
  amount: number;
  created_at: number;
  expires_at: number;
}

/** Get info result */
export interface GetInfoResult {
  alias?: string;
  color?: string;
  pubkey?: string;
  network?: string;
  block_height?: number;
  block_hash?: string;
  methods?: string[];
  notifications?: string[];
}

/** Lookup invoice result */
export interface LookupInvoiceResult {
  transaction_type: "incoming" | "outgoing";
  invoice?: string;
  description?: string;
  description_hash?: string;
  preimage?: string;
  payment_hash: string;
  amount: number;       // msats
  fees_paid?: number;
  created_at: number;
  settled_at?: number;
}

/** Get budget result */
export interface GetBudgetResult {
  total_budget?: number;
  remaining_budget?: number;
  used_budget?: number;
  renewal_period?: string;
}
