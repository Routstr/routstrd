// NIP-47 NWC (Nostr Wallet Connect) client for routstrd
// Uses nostr-tools for key management and encryption,
// Bun's native WebSocket for relay communication.
//
// Encryption: auto-detects NIP-04 vs NIP-44 by reading the wallet's
// kind-13194 info event on connect, per the NIP-47 encryption negotiation spec.
// If the info event has an "encryption" tag listing supported schemes,
// nip44_v2 is preferred. Otherwise falls back to NIP-04.

import {
  getPublicKey,
  nip04,
  nip44,
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
  clientSecretKey?: string;
  replyTimeoutMs?: number;
  publishTimeoutMs?: number;
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
  getBalance(): Promise<number>;
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

  const clientSecretKey = options.clientSecretKey
    ? Buffer.from(options.clientSecretKey, "hex")
    : Buffer.from(parsed.secret, "hex");
  const clientPubkeyHex = getPublicKey(clientSecretKey);
  const nwc44ConvKey = nip44.getConversationKey(clientSecretKey, walletPubkey);

  // ── State ──────────────────────────────────────────────────────
  let ws: WebSocket | null = null;
  let connected = false;
  let subscriptionReady = false;
  let subscriptionId: string | null = null;
  let reconnectAttempts = 0;
  let stopReconnecting = false;
  let useEncryption: "nip04" | "nip44_v2" = "nip04";

  const queue: QueuedCall[] = [];
  let sending = false;

  // ── Logging ────────────────────────────────────────────────────
  function log(...args: unknown[]) { logger.log("[nwc]", ...args); }
  function debugLog(...args: unknown[]) { logger.debug("[nwc]", ...args); }

  // ── Encryption helpers ─────────────────────────────────────────

  function encryptPayload(payload: string): string {
    if (useEncryption === "nip44_v2") {
      return nip44.encrypt(payload, nwc44ConvKey);
    }
    // nostr-tools v2 nip04.encrypt is sync but typed as Promise-like
    return nip04.encrypt(clientSecretKey, walletPubkey, payload) as unknown as string;
  }

  function decryptPayload(payload: string): string {
    if (useEncryption === "nip44_v2") {
      return nip44.decrypt(payload, nwc44ConvKey);
    }
    return nip04.decrypt(clientSecretKey, walletPubkey, payload) as unknown as string;
  }

  // ── Event helpers ──────────────────────────────────────────────

  function createSignedEvent(
    kind: number, content: string, tags: string[][],
  ): NostrEvent {
    const template: EventTemplate = {
      kind, created_at: Math.floor(Date.now() / 1000), tags, content,
    };
    const event = finalizeEvent(template, clientSecretKey);
    return {
      id: event.id, pubkey: event.pubkey, created_at: event.created_at,
      kind: event.kind, tags: event.tags, content: event.content, sig: event.sig,
    };
  }

  function sendRaw(message: unknown[]): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  function buildRequestTags(): string[][] {
    const tags: string[][] = [["p", walletPubkey]];
    if (useEncryption === "nip44_v2") tags.unshift(["encryption", "nip44_v2"]);
    return tags;
  }

  // ── Queue processing ───────────────────────────────────────────

  function sendNextFromQueue(): void {
    if (sending || queue.length === 0 || !connected || !ws) return;
    sending = true;
    const call = queue[0]!;
    try {
      const requestContent: NwcRequest = { method: call.method, params: call.params };
      const requestJson = JSON.stringify(requestContent);
      debugLog(`Sending ${call.method} (queue: ${queue.length}, enc: ${useEncryption})`);
      const encrypted = encryptPayload(requestJson);
      const event = createSignedEvent(NWC_REQUEST_KIND, encrypted, buildRequestTags());
      sendRaw(["EVENT", event]);
      debugLog(`Published ${call.method} req ${event.id.slice(0, 8)}...`);
    } catch (error) {
      const failed = queue.shift()!;
      clearTimeout(failed.timeout);
      failed.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      sending = false;
    }
  }

  function handleResponse(event: NostrEvent): void {
    if (event.pubkey !== walletPubkey) return;
    const pTag = event.tags.find((t) => t.length >= 2 && t[0] === "p");
    if (!pTag || pTag[1] !== clientPubkeyHex) return;
    if (queue.length === 0) { debugLog("NWC response but no pending calls"); return; }

    try {
      debugLog(`Decrypting response ${event.id.slice(0, 8)}...`);
      const decrypted = decryptPayload(event.content);
      debugLog(`Decrypted: ${decrypted.slice(0, 200)}`);
      const response = JSON.parse(decrypted) as NwcResponse;
      const resultType = response.result_type;
      let call: QueuedCall | undefined;

      if (resultType) {
        const idx = queue.findIndex((c) => c.method === resultType);
        if (idx >= 0) {
          call = queue[idx]; queue.splice(idx, 1);
          debugLog(`Matched response to ${resultType} (idx ${idx})`);
        } else {
          debugLog(`Ignoring stale response for ${resultType}`);
          return;
        }
      } else {
        debugLog("No result_type, using queue head");
        call = queue.shift()!;
      }
      clearTimeout(call.timeout);
      if (response.error) {
        call.reject(new Error(
          `NWC error (${response.error.code}): ${response.error.message}`));
      } else {
        call.resolve(response);
      }
    } catch (error) {
      const call = queue.shift()!;
      clearTimeout(call.timeout);
      call.reject(new Error(
        `Failed to parse NWC response: ${(error as Error).message}`));
    }
    sendNextFromQueue();
  }

  // ── Enqueue ────────────────────────────────────────────────────

  function enqueueCall(
    method: NwcMethod, params: Record<string, unknown>,
  ): Promise<NwcResponse> {
    if (!connected || !ws) {
      return Promise.reject(new Error("NWC client not connected"));
    }
    return new Promise<NwcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = queue.findIndex((c) => c.resolve === resolve);
        if (idx >= 0) queue.splice(idx, 1);
        sendNextFromQueue();
        reject(new Error(
          `NWC '${method}' timed out after ${replyTimeoutMs}ms`));
      }, replyTimeoutMs);
      queue.push({ method, params, resolve, reject, timeout });
      sendNextFromQueue();
    });
  }

  // ── Encryption negotiation ─────────────────────────────────────
  // Fetches the wallet's info event (kind 13194) to check supported encryption.

  function negotiateEncryption(): void {
    const infoSubId = `nwc-info-${clientPubkeyHex.slice(0, 8)}`;
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      try { sendRaw(["CLOSE", infoSubId]); } catch { /* ok */ }
    };

    const timeout = setTimeout(() => {
      debugLog("Info event fetch timed out, defaulting to nip04");
      finish();
    }, publishTimeoutMs);

    const originalOnMsg = ws!.onmessage;
    ws!.onmessage = (evt) => {
      const raw = typeof evt.data === "string"
        ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer);
      let msg: unknown[];
      try { msg = JSON.parse(raw); } catch {
        originalOnMsg?.call(ws, evt); return;
      }
      if (!Array.isArray(msg) || msg.length < 2) {
        originalOnMsg?.call(ws, evt); return;
      }

      if (msg[0] === "EVENT" && msg.length >= 3) {
        const ev = msg[2] as NostrEvent;
        if (ev.kind === 13194 && ev.pubkey === walletPubkey) {
          clearTimeout(timeout);
          debugLog(`Got wallet info: "${ev.content}" tags: ${JSON.stringify(ev.tags)}`);
          const encTag = ev.tags.find((t) => t.length >= 2 && t[0] === "encryption");
          if (encTag) {
            const schemes = encTag[1].split(/\s+/);
            debugLog(`Wallet encryption: ${schemes.join(", ")}`);
            if (schemes.includes("nip44_v2")) {
              useEncryption = "nip44_v2";
              log("Negotiated encryption: nip44_v2");
            }
          } else {
            debugLog("No encryption tag, using nip04 (default)");
          }
          ws!.onmessage = originalOnMsg;
          finish(); return;
        }
      }
      if (msg[0] === "EOSE") {
        clearTimeout(timeout);
        debugLog("Info event not found, defaulting to nip04");
        ws!.onmessage = originalOnMsg;
        finish(); return;
      }
      originalOnMsg?.call(ws, evt);
    };

    sendRaw(["REQ", infoSubId, { kinds: [13194], authors: [walletPubkey] }]);
  }

  // ── Relay message handler ──────────────────────────────────────

  function handleRelayMessage(raw: string): void {
    let msg: unknown[];
    try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg) || msg.length < 2) return;
    const type = msg[0] as string;

    if (type === "EVENT" && msg.length >= 3) {
      const event = msg[2] as NostrEvent;
      if (event?.kind === NWC_RESPONSE_KIND) handleResponse(event);
      return;
    }
    if (type === "OK") {
      const success = msg[2] as boolean;
      debugLog(`Event ${(msg[1]as string).slice(0,8)}... ${success ? "accepted" : "rejected: "+msg[3]}`);
      return;
    }
    if (type === "NOTICE") { log(`Relay notice: ${msg[1]}`); return; }
    if (type === "EOSE") {
      if (msg[1] === subscriptionId) subscriptionReady = true;
      debugLog(`EOSE for sub ${msg[1]}`);
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
          reject(new Error(`NWC relay connection timed out for ${relayUrl}`));
        }, publishTimeoutMs);

        socket.onopen = () => {
          clearTimeout(connectTimeout);
          ws = socket;
          connected = true;
          subscriptionReady = false;
          reconnectAttempts = 0;
          log("Connected to NWC relay");

          // Subscribe to response events tagged for us
          subscriptionId = `routstrd-nwc-${clientPubkeyHex.slice(0, 8)}`;
          sendRaw(["REQ", subscriptionId, {
            kinds: [NWC_RESPONSE_KIND], "#p": [clientPubkeyHex],
          }]);
          debugLog(`Subscribed: ${subscriptionId}`);

          // Fetch wallet info event for encryption negotiation
          negotiateEncryption();

          // Wait for EOSE to confirm subscription is active
          const waitForReady = () => {
            if (subscriptionReady || !connected) resolve();
            else setTimeout(waitForReady, 50);
          };
          // Safety timeout: resolve anyway after 5s
          setTimeout(() => {
            if (!subscriptionReady && connected) {
              log("EOSE timeout, proceeding");
              resolve();
            }
          }, 5000);
          waitForReady();
        };

        socket.onmessage = (event) => {
          const data = typeof event.data === "string"
            ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
          handleRelayMessage(data);
        };

        socket.onclose = (event) => {
          log(`NWC relay disconnected: code=${event.code} reason="${event.reason}"`);
          connected = false; subscriptionReady = false; ws = null;
          while (queue.length > 0) {
            const call = queue.shift()!;
            clearTimeout(call.timeout);
            call.reject(new Error("NWC relay connection closed"));
          }
          if (!stopReconnecting && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
            log(`Reconnecting in ${delay}ms (${reconnectAttempts}/${maxReconnectAttempts})`);
            setTimeout(() => {
              doConnect().catch((err) => logger.error("[nwc] Reconnect failed:", err));
            }, delay);
          } else if (stopReconnecting) {
            log("Reconnect disabled");
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
      if (connected) { log("Already connected"); return; }
      stopReconnecting = false;
      await doConnect();
    },

    disconnect() {
      stopReconnecting = true;
      if (ws) {
        if (subscriptionId) { try { sendRaw(["CLOSE", subscriptionId]); } catch {} subscriptionId = null; }
        ws.close(); ws = null;
      }
      connected = false; subscriptionReady = false;
      while (queue.length > 0) {
        const call = queue.shift()!;
        clearTimeout(call.timeout);
        call.reject(new Error("NWC client disconnected"));
      }
      log("Disconnected");
    },

    isConnected() { return connected; },

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
      return Math.floor(((response.result?.balance as number) || 0) / 1000);
    },

    async payInvoice(invoice, amount?) {
      const params: Record<string, unknown> = { invoice };
      if (amount !== undefined) params.amount = amount * 1000;
      const response = await enqueueCall("pay_invoice", params);
      const result = response.result || {};
      return {
        preimage: (result.preimage as string) || "",
        fees_paid: result.fees_paid as number | undefined,
      };
    },

    async makeInvoice(params) {
      const response = await enqueueCall("make_invoice", {
        amount: params.amount * 1000,
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
      if (!response.result) return null;
      const result = response.result;
      return {
        transaction_type: (result.transaction_type as "incoming" | "outgoing") || "incoming",
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
