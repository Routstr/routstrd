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

Requires the `cu-prover` binary (build it
from <https://github.com/jooray/routstr-confidential>: `cd crypto && cargo build
--release -p zkbench --bin cu-prover`, binary in `crypto/zkbench/target/release/`),
and for protocol v2 nodes `cu-2pc` next to it. Protocol v1 sessions also need
Bun ≥ 1.4, because their TLS handshake uses WebCrypto X25519 (the SDK checks
this only for v1); v2 uses a joint P-256 key share.

## Pre-warming (protocol v2)

With a protocol v2 node, most of a cold request is the two-party
preprocessing: about 22 MB from the node and 1.2 MB to it, about 7 s on a home
link with a 2 Mbit/s uplink. routstrd
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
      "maxPerKey": 6,
      "maxTotal": 6,
      "maxAgeSeconds": 480,
      "maxSessionFeeMsat": 5000
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns pre-warming off (every request runs cold) |
| `activityWindowMinutes` | 10 | a (node, model, `max_tokens`) with no request in this window keeps no armed sessions; any it holds are closed at once |
| `maxPerKey` | 6 | armed sessions per key |
| `maxTotal` | 6 | armed sessions in total. Nodes limit unused sessions per client address (default 12, `CONFIDENTIAL_MAX_UNUSED_PER_IP`), counting armed sessions and requests still in their handshake; keep `maxTotal` below that limit |
| `maxAgeSeconds` | 480 | retire an armed session this long after its setup (the node ends a session 600 s after accepting its websocket; capped at 570) |
| `maxSessionFeeMsat` | 5000 | pre-warm only nodes whose abandon fee (`abandon_fee_msat` in the signed offer: what an unused session costs) is at most this; `0` never pre-warms a node that charges one |
| `maxArmedWithFee` | 6 | armed sessions in total for nodes that charge an abandon fee. Raise it for parallel agents (subagents): each session that ends unused costs the fee. Keep it below the node's unused-sessions-per-address limit |

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
then releases its reservation without a charge (unless it charges an abandon
fee, below). While sessions are armed,
the balance the node reports is lower by their reservations. Pre-warming is
not used in `xcashu` mode, where every request spends a fresh token.

**Session fees.** A node may charge for its own work (most charge nothing):
a rate surcharge (already in the offer's rates), a session fee added to every
completed request, and an abandon fee (at least the session fee) for a session
that ends without a request reaching the provider. A pre-warmed session that
is used costs its usage + the session fee; one that expires unused costs the
abandon fee. routstrd therefore arms at most `maxArmedWithFee` (default 6) sessions for a node with
an abandon fee (whatever `maxPerKey` says), none if the fee is above
`maxSessionFeeMsat`, and logs the fee of each session it closes unused
(`… abandon fee N msats paid, M msats on unused sessions so far`). Worst case,
an active key that goes idle pays one abandon fee per idle period. Set
`maxSessionFeeMsat` to `0` to never pay for unused sessions (every request
then runs cold). The deposit routstrd tops up for a request includes the
larger fee and any rate surcharge; the receipt check allows usage × signed
rates + the session fee.

Pool activity is logged at info level in the daemon log (`[confidential-prewarm]`:
arming, armed, claim, retire, backoff), without credentials. Responses carry
`x-routstr-confidential-prewarmed: 1` when served from an armed session.


Each armed session also pre-generates the setup of its three zero-knowledge proofs (a "proof channel"), so
a request that finds an armed session spends well under a second on proofs. Measured against a production node: about 2–3 s to the first token warm (mostly the provider's
latency). Cold requests are dominated by receiving ~22 MB of 2PC data: seconds on a fast connection, about
14–16 s from a good home connection (100 Mbit/s down) and 45–70 s on a slow, download-limited
link. Arming one session takes
about as long as a cold two-party computation and moves about 22 MB to the client and 1.2 MB from it, in the
background.
