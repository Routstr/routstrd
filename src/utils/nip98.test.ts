import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { generateSecretKey, getEventHash, getPublicKey, verifyEvent, type Event } from "nostr-tools";
import { createNIP98Authorization } from "./nip98";

function decode(header: string): Event {
  expect(header.startsWith("Nostr ")).toBe(true);
  return JSON.parse(atob(header.slice(6))) as Event;
}

describe("createNIP98Authorization", () => {
  let now: ReturnType<typeof spyOn<typeof Date, "now">>;
  beforeEach(() => { now = spyOn(Date, "now"); });
  afterEach(() => now.mockRestore());

  for (const method of ["GET", "POST"] as const) {
    test(`identical ${method} requests in the same second have unique signed ids`, async () => {
      now.mockReturnValue(1_800_000_000_000);
      const secret = generateSecretKey();
      const url = "https://routstr.example/npubs?limit=10";
      const body = method === "POST" ? new TextEncoder().encode('{"name":"Alice"}') : undefined;
      const firstHeader = await createNIP98Authorization(secret, url, method, body);
      const first = decode(firstHeader);
      const second = decode(await createNIP98Authorization(secret, url, method, body));

      expect(first.created_at).toBe(1_800_000_000);
      expect(second.created_at).toBe(first.created_at);
      expect(first.id).not.toBe(second.id);
      const nonce = (event: Event) => event.tags.find(tag => tag[0] === "nonce")?.[1];
      expect(nonce(first)).toMatch(/^[0-9a-f-]{36}$/);
      expect(nonce(second)).not.toBe(nonce(first));
      for (const event of [first, second]) {
        expect(event.pubkey).toBe(getPublicKey(secret));
        expect(event.kind).toBe(27235);
        expect(event.content).toBe("");
        expect(event.tags).toContainEqual(["u", url]);
        expect(event.tags).toContainEqual(["method", method]);
        expect(event.id).toBe(getEventHash(event));
        expect(verifyEvent(event)).toBe(true);
        if (body) {
          const hash = Buffer.from(await crypto.subtle.digest("SHA-256", body)).toString("hex");
          expect(event.tags).toContainEqual(["payload", hash]);
        } else {
          expect(event.tags.some(tag => tag[0] === "payload")).toBe(false);
        }
      }
      // Reusing a header still reuses its id: entropy is added at signing time,
      // not when decoding or verifying it. A server can reject that exact replay.
      expect(decode(firstHeader).id).toBe(first.id);
      const tampered = decode(firstHeader);
      tampered.tags.find(tag => tag[0] === "nonce")![1] = "changed";
      expect(verifyEvent(tampered)).toBe(false);
    });
  }
});
