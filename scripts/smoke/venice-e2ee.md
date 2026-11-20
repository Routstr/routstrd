# Venice E2EE smoke test

Requires a funded wallet, a known enabled Core provider with native Venice metadata routes, and an SDK build that forwards the three Venice TEE headers. Unpatched SDK 0.4.9 drops those headers.

```sh
bun scripts/smoke/venice-e2ee.ts \
  --provider http://localhost:8000/ \
  --model e2ee-gemma-4-26b-a4b-uncensored-p \
  --trust-server-attestation
```

The daemon defaults to `http://localhost:8008`; override it with `--base-url`. Set `ROUTSTR_API_KEY` if needed. Never provide an upstream Venice credential to the client.

The script encrypts a fixed prompt, requests up to 64 output tokens, and requires decrypted output containing `ENCRYPTED_OK`. Plaintext, tampered ciphertext and incomplete streams fail closed. The SDK may allocate provider credit; the token limit is not a spending cap.

**Experimental:** `--trust-server-attestation` accepts server-side verification. It does not independently verify hardware quotes, workload measurements or response signatures, and does not enable E2EE for ordinary Pi/OpenAI clients. An `e2ee-*` model name alone does not establish encryption support through an aggregator.

```sh
bun test src/daemon/http/tee-metadata.test.ts scripts/smoke/venice-e2ee.test.ts
```
