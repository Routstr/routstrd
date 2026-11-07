import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parseArgs } from "node:util";

const INFO = Buffer.from("ecdsa_encryption");

export function keypair() {
  const privateKey = secp256k1.utils.randomSecretKey();
  return {
    privateKey,
    getPublicKey: () => Buffer.from(secp256k1.getPublicKey(privateKey, false)),
    computeSecret: (peer: Buffer) =>
      Buffer.from(
        secp256k1.getSharedSecret(privateKey, peer, false).slice(1, 33),
      ),
  };
}

export function publicKey(value: unknown): Buffer {
  if (typeof value !== "string") throw new Error("Missing enclave public key");
  const hex = value.replace(/^0x/, "");
  const normalized = hex.length === 128 ? "04" + hex : hex;
  if (!/^04[0-9a-fA-F]{128}$/.test(normalized))
    throw new Error("Invalid enclave public key");
  const bytes = Buffer.from(normalized, "hex");
  secp256k1.Point.fromBytes(bytes).assertValidity();
  return bytes;
}

export function checkAttestation(
  a: Record<string, unknown>,
  nonce: string,
  model: string,
): Buffer {
  // These checks trust the upstream verifier, NOT an independent Intel/NVIDIA
  // trust chain. The CLI requires explicit opt-in to that experimental mode.
  if (a.verified !== true || a.nonce !== nonce || a.model !== model) {
    throw new Error("Attestation status, nonce or model mismatch");
  }
  if (a.signing_algo !== undefined && a.signing_algo !== "ecdsa")
    throw new Error("Unsupported signing algorithm");
  return publicKey(a.signing_key || a.signing_public_key);
}

export function encrypt(plaintext: string, recipient: Buffer): string {
  const ephemeral = keypair();
  const secret = ephemeral.computeSecret(recipient);
  const key = Buffer.from(
    hkdfSync("sha256", secret, Buffer.alloc(0), INFO, 32),
  );
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const data = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([
      ephemeral.getPublicKey(),
      nonce,
      data,
      cipher.getAuthTag(),
    ]).toString("hex");
  } finally {
    secret.fill(0);
    key.fill(0);
    ephemeral.privateKey.fill(0);
  }
}

export function decrypt(
  hex: string,
  client: ReturnType<typeof keypair>,
): string {
  if (!/^[a-fA-F0-9]+$/.test(hex) || hex.length < 186 || hex.length % 2) {
    throw new Error("Expected encrypted output; refusing plaintext fallback");
  }
  const raw = Buffer.from(hex, "hex");
  const peer = publicKey(raw.subarray(0, 65).toString("hex"));
  const secret = client.computeSecret(peer);
  const key = Buffer.from(
    hkdfSync("sha256", secret, Buffer.alloc(0), INFO, 32),
  );
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, raw.subarray(65, 77));
    cipher.setAuthTag(raw.subarray(-16));
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat([cipher.update(raw.subarray(77, -16)), cipher.final()]),
    );
  } finally {
    secret.fill(0);
    key.fill(0);
  }
}

export async function readEncryptedStream(
  response: Response,
  client: ReturnType<typeof keypair>,
) {
  if (!response.ok) throw new Error(`Inference HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    throw new Error("Expected SSE");
  if (!response.body) throw new Error("Missing stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    data: string[] = [],
    content = "",
    reasoning = "",
    id = "",
    chunks = 0,
    finished = false;
  function event() {
    if (!data.length) return;
    const text = data.join("\n");
    data = [];
    if (text === "[DONE]") {
      finished = true;
      return;
    }
    const frame = JSON.parse(text);
    if (frame.error) throw new Error("Upstream stream error");
    if (frame.id) id = frame.id;
    for (const choice of frame.choices || []) {
      const delta = choice.delta || {};
      if (delta.tool_calls || delta.function_call)
        throw new Error(
          "Tool calls are outside this smoke test privacy contract",
        );
      for (const field of ["content", "reasoning_content", "reasoning"]) {
        if (delta[field] == null || delta[field] === "") continue;
        if (typeof delta[field] !== "string")
          throw new Error("Unexpected output shape");
        const plain = decrypt(delta[field], client);
        chunks++;
        if (field === "content") content += plain;
        else reasoning += plain;
      }
    }
  }
  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2 * 1024 * 1024)
        throw new Error("SSE buffer limit exceeded");
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) event();
        else if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
        if (data.join("\n").length > 2 * 1024 * 1024)
          throw new Error("SSE event limit exceeded");
        if (finished) break;
      }
    }
    if (!finished || !chunks)
      throw new Error("Incomplete or empty encrypted stream");
    return { id, content, reasoning, encryptedChunks: chunks };
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function smoke(options: {
  baseUrl: string;
  provider: string;
  model: string;
  trustServer: boolean;
}) {
  if (!options.trustServer)
    throw new Error(
      "Independent quote verification is not implemented. Explicitly opt in with --trust-server-attestation for a non-sensitive experiment.",
    );
  const base = options.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
  const nonce = randomBytes(32).toString("hex");
  const headers: Record<string, string> = {
    "x-routstr-provider": options.provider,
  };
  if (process.env.ROUTSTR_API_KEY)
    headers.authorization = `Bearer ${process.env.ROUTSTR_API_KEY}`;
  const evidenceUrl = new URL(base + "/v1/tee/attestation");
  evidenceUrl.searchParams.set("model", options.model);
  evidenceUrl.searchParams.set("nonce", nonce);
  const evidence = await fetch(evidenceUrl, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(35_000),
  });
  if (!evidence.ok) throw new Error(`Attestation HTTP ${evidence.status}`);
  const key = checkAttestation(await evidence.json(), nonce, options.model);
  const client = keypair();
  try {
    const response = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
      headers: {
        ...headers,
        "content-type": "application/json",
        "X-Venice-TEE-Client-Pub-Key": client.getPublicKey().toString("hex"),
        "X-Venice-TEE-Model-Pub-Key": key.toString("hex"),
        "X-Venice-TEE-Signing-Algo": "ecdsa",
      },
      body: JSON.stringify({
        model: options.model,
        stream: true,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: encrypt("Reply with exactly: ENCRYPTED_OK", key),
          },
        ],
        venice_parameters: {
          include_venice_system_prompt: false,
          disable_thinking: true,
        },
      }),
    });
    const result = await readEncryptedStream(response, client);
    if (!result.content.includes("ENCRYPTED_OK"))
      throw new Error(
        "Decrypted response did not contain the requested marker",
      );
    return {
      ...result,
      verification:
        "server-attestation-only; hardware trust chain and response signature NOT independently verified",
    };
  } finally {
    client.privateKey.fill(0);
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string", default: "http://localhost:8008" },
      provider: { type: "string" },
      model: { type: "string" },
      "trust-server-attestation": { type: "boolean", default: false },
    },
  });
  if (!values.provider || !values.model)
    throw new Error("--provider and --model are required");
  console.log(
    JSON.stringify(
      await smoke({
        baseUrl: values["base-url"]!,
        provider: values.provider,
        model: values.model,
        trustServer: values["trust-server-attestation"]!,
      }),
      null,
      2,
    ),
  );
}
