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

## Pre-warming (protocol v2)

With a protocol v2 node, most of a cold request is the two-party
preprocessing: about 21 MB each way, roughly 25 s on a home uplink. routstrd
can run it before a request arrives. It keeps a few **armed** sessions per
(node, model, `max_tokens`) that recently had traffic. An armed session has
done the setup and the preprocessing but not the TLS handshake, so a request
that claims one only waits for the fast part (about 2 s plus the provider's
own latency).

It is on by default and only reacts to traffic. An idle routstrd keeps no
armed sessions and runs no timer. Configure it in `confidentialUpstream`:

```json
{
  "confidentialUpstream": {
    "enabled": true,
    "prewarm": {
      "enabled": true,
      "activityWindowMinutes": 10,
      "maxPerKey": 2,
      "maxTotal": 2,
      "maxAgeSeconds": 480
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns pre-warming off (every request runs cold) |
| `activityWindowMinutes` | 10 | a (node, model, `max_tokens`) with no request in this window keeps no armed sessions; any it holds are closed at once |
| `maxPerKey` | 2 | armed sessions per key |
| `maxTotal` | 2 | armed sessions in total. Nodes limit unused sessions per client address (default 3, `CONFIDENTIAL_MAX_UNUSED_PER_IP`), counting armed sessions and requests still in their handshake; keep `maxTotal` below that limit |
| `maxAgeSeconds` | 480 | retire an armed session this long after its setup (the node ends sessions at 600 s; capped at 570) |

How many sessions it keeps per key: 1 while the key is active, 2 after 3
requests within 5 minutes, and at least as many as the most requests that
overlapped in the window. The arming of a session starts only after a request
for that key has settled, and only one arm runs at a time. No arm starts
while a cold request is still in its own preprocessing. Each session is armed
for a body-length bucket (a power of two ≥ 4 KiB, from the largest of the
last 20 request bodies × 1.25). A larger request runs cold and raises the
bucket. Smaller bodies are padded with spaces inside the JSON.

**Funds.** Each armed session holds a reservation on the node credential (a
full-context prompt plus `max_tokens` at the offer rates), like an in-flight
request. routstrd arms only while the credential's available balance on the
node covers twice the last observed reservation (the new arm plus one cold
request). An unused session is closed before the node's limit, and the node
then releases its reservation without a charge. While sessions are armed,
the balance the node reports is lower by their reservations. Pre-warming is
not used in `xcashu` mode, where every request spends a fresh token.

Pool activity is logged at info level in the daemon log (`[confidential-prewarm]`:
arming, armed, claim, retire, backoff), without credentials. Responses carry
`x-routstr-confidential-prewarmed: 1` when served from an armed session.


Each armed session also pre-generates the setup of its three zero-knowledge proofs (a "proof channel"), so
a request that finds an armed session spends well under a second on proofs. Measured from a home uplink
against a production node: about 2–3 s to the first token warm, about 35 s cold. Arming one session takes
about a minute on a slow uplink and moves roughly 23 MB each way, in the background.
