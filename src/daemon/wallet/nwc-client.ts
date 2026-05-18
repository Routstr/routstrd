// NIP-47 NWC (Nostr Wallet Connect) client for routstrd
// Uses nostr-tools for key management and NIP-04 encryption,
// Bun's native WebSocket for relay communication.

import {
  getPublicKey,
  nip04,
  finalizeEvent,
  type EventTemplate,
} from "nostr-tools";
import { logger } from "../../utils/logger";
import type {
  NwcConnectionString,
  NwcRequest,
  NwcResponse,
  NostrEvent,
  NwcMethod,
} from "./nwc-types";
import { NWC_REQUEST_KIND, NWC_RESPONSE_KIND } from "./nwc-types";

// ── Connection string parsing ──────────────────────────────────────

export function parseConnectionString(uri: string): NwcConnectionString {
  const url = new URL(uri);

  if (url.protocol !== "nostr+walletconnect:") {
    throw new Error(
      `Invalid NWC connection string protocol: ${url.protocol}. Expected nostr+walletconnect:`,
    );
  }

  const pubkey = url.hostname;
  const relay = url.searchParams.get("relay");
  const secret = url.searchParams.get("secret");

  if (!pubkey || pubkey.length !== 64) {
    throw new Error("Invalid NWC connection string: missing or invalid pubkey");
  }
  if (!relay) {
    throw new Error("Invalid NWC connection string: missing relay parameter");
  }
  if (!secret || secret.length !== 64) {
    throw new Error(
      "Invalid NWC connection string: missing or invalid secret (expected 32-byte hex)",
    );
  }

  return { pubkey, relay, secret };
}

export function validateConnectionString(
  uri: string,
): { valid: true; parsed: NwcConnectionString } | { valid: false; error: string } {
  try {
    const parsed = parseConnectionString(uri);
    return { valid: true, parsed };
  } catch (error) {
    return { valid: false, error: (error as Error).message };
  }
}

// ── Client options and interface ────────────────────────────────────

export interface NwcClientOptions {
  connectionString: string;
  /** Optional client private key (hex). Generated randomly if omitted. */
  clientSecretKey?: string;
  /** Timeout for wallet response (ms). Default: 60000 */
  replyTimeoutMs?: number;
  /** Timeout for relay operations (ms). Default: 10000 */
  publishTimeoutMs?: number;
  /** Max auto-reconnect attempts. Default: 5 */
  maxReconnectAttempts?: number;
}

export interface NwcClient {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  getInfo(): Promise<{
    alias: string;
    pubkey: string;
    network?: string;
    methods: string[];
  }>;
  getBalance(): Promise<number>; // in sats
  payInvoice(invoice: string, amount?: number): Promise<{
    preimage: string;
    fees_paid?: number;
  }>;
  makeInvoice(params: {
    amount: number;
    description?: string;
  }): Promise<{
    invoice: string;
    payment_hash: string;
    amount: number;
  }>;
  lookupInvoice(params: {
    payment_hash?: string;
    invoice?: string;
  }): Promise<{
    transaction_type: "incoming" | "outgoing";
    invoice?: string;
    preimage?: string;
    payment_hash: string;
    amount: number;
    fees_paid?: number;
    settled_at?: number;
  } | null>;
}

// ── Client implementation ───────────────────────────────────────────

/** A queued request with method, params, and promise callbacks */
interface QueuedCall {
  method: NwcMethod;
  params: Record<string, unknown>;
  resolve: (response: NwcResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function createNwcClient(options: NwcClientOptions): NwcClient {
  const parsed = parseConnectionString(options.connectionString);
  const walletPubkey = parsed.pubkey;
  const relayUrl = parsed.relay;
  const replyTimeoutMs = options.replyTimeoutMs ?? 60000;
  const publishTimeoutMs = options.publishTimeoutMs ?? 10000;
  const maxReconnectAttempts = options.maxReconnectAttempts ?? 5;

  // Client keypair — use secret from the connection string (per NIP-47)
  const clientSecretKey = options.clientSecretKey
    ? Buffer.from(options.clientSecretKey, "hex")
    : Buffer.from(parsed.secret, "hex");
  // getPublicKey returns a hex string (not Uint8Array) so use it directly
  const clientPubkeyHex = getPublicKey(clientSecretKey);

  // ── State ──────────────────────────────────────────────────────
  let ws: WebSocket | null = null;
  let connected = false;
  let subscriptionId: string | null = null;
  let reconnectAttempts = 0;
  let stopReconnecting = false;

  // Serialized request queue — we process one NWC request at a time
  // because NIP-47 doesn't mandate request/response correlation IDs.
  const queue: QueuedCall[] = [];
  let sending = false;

  // ── Logging helpers ────────────────────────────────────────────
  function log(...args: unknown[]) {
    logger.log("[nwc]", ...args);
  }
  function debugLog(...args: unknown[]) {
    logger.debug("[nwc]", ...args);
  }

  // ── Nostr helpers ──────────────────────────────────────────────
  function createSignedEvent(
    kind: number,
    content: string,
    tags: string[][],
  ): NostrEvent {
    const template: EventTemplate = {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    };
    const event = finalizeEvent(template, clientSecretKey);
    return {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    };
  }

  function sendRaw(message: unknown[]): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  // ── Queue processing ───────────────────────────────────────────

  /** Dequeue and send the next request from the queue head */
  async function sendNextFromQueue(): Promise<void> {
    if (sending || queue.length === 0 || !connected || !ws) return;
    sending = true;

    const call = queue[0]!;
    try {
      const requestContent: NwcRequest = {
        method: call.method,
        params: call.params,
      };
      const requestJson = JSON.stringify(requestContent);

      debugLog(`Sending ${call.method} (queue depth: ${queue.length})`);

      const encrypted = await nip04.encrypt(
        clientSecretKey,
        walletPubkey,
        requestJson,
      );

      const event = createSignedEvent(NWC_REQUEST_KIND, encrypted, [
        ["p", walletPubkey],
      ]);

      sendRaw(["EVENT", event]);
      debugLog(`Published ${call.method} request ${event.id.slice(0, 8)}...`);
    } catch (error) {
      // Send failed — reject this call and move on
      const failed = queue.shift()!;
      clearTimeout(failed.timeout);
      failed.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      sending = false;
    }
  }

  /** Handle a response event from the wallet */
  async function handleResponse(event: NostrEvent): Promise<void> {
    if (event.pubkey !== walletPubkey) return;

    const pTag = event.tags.find((t) => t.length >= 2 && t[0] === "p");
    if (!pTag || pTag[1] !== clientPubkeyHex) return;

    if (queue.length === 0) {
      debugLog("NWC response received but no pending calls");
      return;
    }

    const call = queue.shift()!;
    clearTimeout(call.timeout);

    try {
      debugLog(`Decrypting response ${event.id.slice(0, 8)}...`);
      const decrypted = await nip04.decrypt(
        clientSecretKey,
        walletPubkey,
        event.content,
      );
      debugLog(`Decrypted: ${decrypted.slice(0, 200)}`);

      const response = JSON.parse(decrypted) as NwcResponse;

      if (response.error) {
        call.reject(
          new Error(
            `NWC error (${response.error.code}): ${response.error.message}`,
          ),
        );
      } else {
        call.resolve(response);
      }
    } catch (error) {
      call.reject(
        new Error(
          `Failed to parse NWC response: ${(error as Error).message}`,
        ),
      );
    }

    // Process next in queue
    sendNextFromQueue();
  }

  // ── Enqueue a call ─────────────────────────────────────────────

  function enqueueCall(
    method: NwcMethod,
    params: Record<string, unknown>,
  ): Promise<NwcResponse> {
    if (!connected || !ws) {
      return Promise.reject(new Error("NWC client not connected"));
    }

    return new Promise<NwcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = queue.findIndex((c) => c.resolve === resolve);
        if (idx >= 0) {
          queue.splice(idx, 1);
        }
        sendNextFromQueue();
        reject(
          new Error(`NWC '${method}' timed out after ${replyTimeoutMs}ms`),
        );
      }, replyTimeoutMs);

      queue.push({ method, params, resolve, reject, timeout });
      sendNextFromQueue();
    });
  }

  // ── Relay message handler ──────────────────────────────────────

  function handleRelayMessage(raw: string): void {
    let msg: unknown[];
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!Array.isArray(msg) || msg.length < 2) return;

    const type = msg[0] as string;

    if (type === "EVENT" && msg.length >= 3) {
      const event = msg[2] as NostrEvent;
      if (event?.kind === NWC_RESPONSE_KIND) {
        handleResponse(event).catch((err) =>
          logger.error("[nwc] Error handling response:", err),
        );
      }
      return;
    }

    if (type === "OK") {
      const eventId = msg[1] as string;
      const success = msg[2] as boolean;
      debugLog(
        `Event ${eventId.slice(0, 8)}... ${success ? "accepted" : `rejected: ${msg[3]}`}`,
      );
      return;
    }

    if (type === "NOTICE") {
      log(`Relay notice: ${msg[1]}`);
      return;
    }

    if (type === "EOSE") {
      debugLog(`EOSE for subscription ${msg[1]}`);
      return;
    }
  }

  // ── Connection lifecycle ───────────────────────────────────────

  function doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        log(`Connecting to NWC relay: ${relayUrl}`);

        const socket = new WebSocket(relayUrl);
        const connectTimeout = setTimeout(() => {
          socket.close();
          reject(
            new Error(
              `NWC relay connection timed out for ${relayUrl}`,
            ),
          );
        }, publishTimeoutMs);

        socket.onopen = () => {
          clearTimeout(connectTimeout);
          ws = socket;
          connected = true;
          reconnectAttempts = 0;
          log(`Connected to NWC relay`);

          // Subscribe to response events (kind 23195) tagged for us
          subscriptionId = `routstrd-nwc-${clientPubkeyHex.slice(0, 8)}`;
          const subFilter = {
            kinds: [NWC_RESPONSE_KIND],
            "#p": [clientPubkeyHex],
          };
          debugLog(`REQ filter: ${JSON.stringify(subFilter)}`);
          sendRaw(["REQ", subscriptionId, subFilter]);
          debugLog(`Subscribed to responses: ${subscriptionId}`);
          resolve();
        };

        socket.onmessage = (event) => {
          const data =
            typeof event.data === "string"
              ? event.data
              : new TextDecoder().decode(event.data as ArrayBuffer);
          handleRelayMessage(data);
        };

        socket.onclose = (event) => {
          log(
            `NWC relay disconnected: code=${event.code} reason="${event.reason}"`,
          );
          connected = false;
          ws = null;

          // Reject all pending calls
          while (queue.length > 0) {
            const call = queue.shift()!;
            clearTimeout(call.timeout);
            call.reject(new Error("NWC relay connection closed"));
          }

          // Auto-reconnect
          if (!stopReconnecting && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            const delay = Math.min(
              1000 * Math.pow(2, reconnectAttempts),
              30000,
            );
            log(
              `Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${maxReconnectAttempts})`,
            );
            setTimeout(() => {
              doConnect().catch((err) =>
                logger.error("[nwc] Reconnect failed:", err),
              );
            }, delay);
          } else if (stopReconnecting) {
            log("Reconnect disabled (explicit disconnect)");
          } else {
            logger.error("[nwc] Max reconnect attempts reached");
          }
        };

        socket.onerror = (err) => {
          logger.error("[nwc] WebSocket error:", err);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  // ── Public API ─────────────────────────────────────────────────

  return {
    async connect() {
      if (connected) {
        log("Already connected");
        return;
      }
      stopReconnecting = false;
      await doConnect();
    },

    disconnect() {
      stopReconnecting = true;
      if (ws) {
        if (subscriptionId) {
          try {
            sendRaw(["CLOSE", subscriptionId]);
          } catch {
            // ignore
          }
          subscriptionId = null;
        }
        ws.close();
        ws = null;
      }
      connected = false;

      while (queue.length > 0) {
        const call = queue.shift()!;
        clearTimeout(call.timeout);
        call.reject(new Error("NWC client disconnected"));
      }

      log("Disconnected from NWC relay");
    },

    isConnected() {
      return connected;
    },

    async getInfo() {
      const response = await enqueueCall("get_info", {});
      const result = response.result || {};
      return {
        alias: (result.alias as string) || "Unknown Wallet",
        pubkey: (result.pubkey as string) || walletPubkey,
        network: result.network as string | undefined,
        methods: (result.methods as string[]) || [],
      };
    },

    async getBalance() {
      const response = await enqueueCall("get_balance", {});
      const balance = (response.result?.balance as number) || 0;
      return Math.floor(balance / 1000); // msats -> sats
    },

    async payInvoice(invoice, amount?) {
      const params: Record<string, unknown> = { invoice };
      if (amount !== undefined) {
        params.amount = amount * 1000; // sats -> msats for NIP-47
      }
      const response = await enqueueCall("pay_invoice", params);
      const result = response.result || {};
      return {
        preimage: (result.preimage as string) || "",
        fees_paid: result.fees_paid as number | undefined,
      };
    },

    async makeInvoice(params) {
      const response = await enqueueCall("make_invoice", {
        amount: params.amount,
        description: params.description || "",
      });
      const result = response.result || {};
      return {
        invoice: (result.invoice as string) || "",
        payment_hash: (result.payment_hash as string) || "",
        amount: (result.amount as number) || params.amount,
      };
    },

    async lookupInvoice(params) {
      const lookupParams: Record<string, unknown> = {};
      if (params.payment_hash) lookupParams.payment_hash = params.payment_hash;
      if (params.invoice) lookupParams.invoice = params.invoice;

      const response = await enqueueCall("lookup_invoice", lookupParams);
      const result = response.result;
      if (!result) return null;

      return {
        transaction_type:
          (result.transaction_type as "incoming" | "outgoing") || "incoming",
        invoice: result.invoice as string | undefined,
        preimage: result.preimage as string | undefined,
        payment_hash: (result.payment_hash as string) || "",
        amount: (result.amount as number) || 0,
        fees_paid: result.fees_paid as number | undefined,
        settled_at: result.settled_at as number | undefined,
      };
    },
  };
}
