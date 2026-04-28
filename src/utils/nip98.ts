import { finalizeEvent, getPublicKey, nip19, type EventTemplate } from "nostr-tools";

const NIP98_KIND = 27235;

export type HttpMethod = "GET" | "POST" | "DELETE";

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("Expected a 64-char hex private key or an nsec private key.");
  }

  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function parseSecretKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Missing Nostr private key.");
  }

  if (trimmed.toLowerCase().startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
      throw new Error("Invalid nsec private key.");
    }
    return decoded.data;
  }

  return hexToBytes(trimmed);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(data));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64EncodeUtf8(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

export function normalizeNostrPubkey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  if (trimmed.toLowerCase().startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function npubFromPubkey(pubkey: string): string {
  return nip19.npubEncode(pubkey.toLowerCase());
}

export function npubFromSecretKey(secretKey: Uint8Array): string {
  return npubFromPubkey(getPublicKey(secretKey));
}

export async function createNIP98Authorization(
  secretKey: Uint8Array,
  url: string,
  method: HttpMethod,
  body?: Uint8Array,
): Promise<string> {
  const tags = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];

  if (body && body.byteLength > 0) {
    tags.push(["payload", await sha256Hex(body)]);
  }

  const template: EventTemplate = {
    kind: NIP98_KIND,
    created_at: Math.round(Date.now() / 1000),
    content: "",
    tags,
  };

  const signed = finalizeEvent(template, secretKey);
  return `Nostr ${base64EncodeUtf8(JSON.stringify(signed))}`;
}
