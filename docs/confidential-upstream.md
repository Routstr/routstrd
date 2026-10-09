# Confidential upstream (routstrd)

Opt-in mode where routstrd is the TLS 1.3 client of the node's upstream
provider: the node relays encrypted records and adds its API key to one
record, but never sees your prompt or the response. Off by default.

It is a transport inside the normal request path. Node selection, the
per-node credential (API key or Cashu token), top-ups, balance accounting,
usage history and refunds work exactly as for other requests.

## Enable

In `~/.routstrd/config.json`:

```json
{
  "confidentialUpstream": {
    "enabled": true,
    "trusted_hosts": ["api.venice.ai", "*.venice.ai"],
    "node_pubkeys": ["npub1…"],
    "prover_path": "/path/to/cu-prover"
  }
}
```

| Key | Meaning |
|---|---|
| `trusted_hosts` | upstream TLS hostnames you accept (exact, `*.x` = one label, `**.x` = any depth). Empty refuses every session. |
| `node_pubkeys` | node Nostr keys whose signed offers you accept (hex or npub) |
| `prover_path` | `cu-prover` binary (else `CU_PROVER_BIN` / `CU_PROVER` / `PATH`) |

Requests opt in with the header `x-routstr-verify: confidential`. They are
routed only to nodes that advertise confidential mode for the model, and fail
rather than silently downgrade: with the header, routstrd answers 400 when
`confidentialUpstream` is not enabled or the endpoint is not
`POST /v1/chat/completions` (the only one the protocol supports), and a
failed proof, receipt or cost check fails the request (or ends the stream
with an error). Streaming responses stream as they decrypt;
non-streaming requests receive one `chat.completion`.

Requires Bun ≥ 1.4 (WebCrypto X25519) and the `cu-prover` binary (build it
from <https://github.com/jooray/routstr-confidential>: `cd crypto && cargo build
--release -p zkbench --bin cu-prover`, binary in `crypto/zkbench/target/release/`).
