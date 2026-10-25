import { describe, expect, it } from "bun:test";
import {
  checkAttestation,
  decrypt,
  encrypt,
  keypair,
  readEncryptedStream,
  smoke,
} from "./venice-e2ee";
function stream(text: string, width = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += width)
          controller.enqueue(bytes.slice(i, i + width));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
const frame = (content: string) =>
  `data: ${JSON.stringify({ id: "test", choices: [{ delta: { content } }] })}\r\n\r\n`;

describe("Venice encrypted smoke client", () => {
  it("decrypts an independent Python cryptography ECIES vector", () => {
    // secp256k1 recipient scalar=1, ephemeral scalar=2, nonce=00..0b;
    // HKDF-SHA256 salt=None, info=ecdsa_encryption; AESGCM, no AAD.
    const k = keypair();
    k.privateKey.fill(0);
    k.privateKey[31] = 1;
    const payload =
      "04c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee51ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a000102030405060708090a0b9c2735b43a57b2db25996c61b82e2d04a1a0614257c43f4a35875680";
    expect(decrypt(payload, k)).toBe("ENCRYPTED_OK");
  });
  it("accepts native signing_public_key and rejects replay and model mismatch", () => {
    const k = keypair();
    const a = {
      verified: true,
      nonce: "nonce",
      model: "model",
      signing_public_key: k.getPublicKey().toString("hex"),
    };
    expect(checkAttestation(a, "nonce", "model")).toEqual(k.getPublicKey());
    expect(() => checkAttestation(a, "other", "model")).toThrow();
    expect(() => checkAttestation(a, "nonce", "other")).toThrow();
    expect(() =>
      checkAttestation({ ...a, verified: false }, "nonce", "model"),
    ).toThrow();
    expect(() =>
      checkAttestation(
        { ...a, signing_public_key: "04" + "00".repeat(64) },
        "nonce",
        "model",
      ),
    ).toThrow();
  });
  it("round-trips Unicode with authenticated encryption and unique ciphertext", () => {
    const k = keypair(),
      text = "Encrypted 🔒 test";
    const encrypted = encrypt(text, k.getPublicKey());
    expect(decrypt(encrypted, k)).toBe(text);
    expect(encrypt(text, k.getPublicKey())).not.toBe(encrypted);
    const tampered = Buffer.from(encrypted, "hex");
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decrypt(tampered.toString("hex"), k)).toThrow();
    expect(() => decrypt(encrypted, keypair())).toThrow();
    expect(() => decrypt("plaintext", k)).toThrow();
  });
  it("handles byte-fragmented SSE and CRLF without dropping ciphertext", async () => {
    const k = keypair();
    const text =
      frame(encrypt("ENCRYPTED_", k.getPublicKey())) +
      frame(encrypt("OK", k.getPublicKey())) +
      "data: [DONE]\r\n\r\n";
    const result = await readEncryptedStream(stream(text), k);
    expect(result.content).toBe("ENCRYPTED_OK");
    expect(result.encryptedChunks).toBe(2);
  });
  it("refuses plaintext downgrade and truncated streams", async () => {
    const k = keypair();
    await expect(
      readEncryptedStream(stream(frame("plaintext") + "data: [DONE]\n\n"), k),
    ).rejects.toThrow("plaintext");
    await expect(
      readEncryptedStream(stream(frame(encrypt("test", k.getPublicKey()))), k),
    ).rejects.toThrow("Incomplete");
    await expect(
      readEncryptedStream(stream("data: [DONE]\n\n"), k),
    ).rejects.toThrow("empty");
  });
  it("will not pretend server-side attestation is independent verification", async () => {
    await expect(
      smoke({
        baseUrl: "http://localhost:8008",
        provider: "https://example.com",
        model: "m",
        trustServer: false,
      }),
    ).rejects.toThrow("Independent quote verification");
  });
});
