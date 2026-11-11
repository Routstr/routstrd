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
| `trusted_hosts` | upstream TLS hostnames you accept (exact, `*.x` = one label, `**.x` = any depth). Empty refuses every session. An entry may name the provider's API base, `api.groq.com/openai/v1`: the node's request route must then be exactly that base plus the endpoint. A bare host allows `/v1` and `/api/v1`. |
| `node_pubkeys` | node Nostr keys whose signed offers you accept (hex or npub). Without it, the keys that announced the node's URL on Nostr (kind 38421) and whose latest review (kind 38425) carries a label the daemon enables are used, for https and onion nodes only. Anyone can announce any URL, so an announcement without such a review is never a pin; a node that has none needs `node_pubkeys` |
| `pin_from_announcement` | `false` (any value other than `true`) requires `node_pubkeys` (no pin taken from the announcement) |
| `prover_path` | `cu-prover` binary (else `CU_PROVER_BIN` / `CU_PROVER` / `PATH`) |
| `allow_insecure_transport` | development only: also run sessions with plain-`http://` nodes that are not loopback or `.onion` (refused by default, since the node credential would cross the network unencrypted, pinned key or not) |

Requests opt in with the header `x-routstr-verify: confidential` (case and
surrounding whitespace are ignored). Any other value of that header (a typo,
a list, an empty value) is refused with 400, never sent on the plain path.
They are
routed only to nodes that advertise confidential mode for the model, and fail
rather than silently downgrade: with the header, routstrd answers 400 when
`confidentialUpstream` is not enabled or the endpoint is not
`POST /v1/chat/completions` or one of the image paths below, and a
failed proof, receipt or cost check fails the request (or ends the stream
with an error). Streaming responses stream as they decrypt, except the final
`data: [DONE]` line: it is sent only once the settlement checks (usage proof,
signed receipt and attestation, cost) have passed. If one fails, the
connection is closed without `[DONE]` and without a clean end of the chunked
body, so a client that reads until `[DONE]` sees an error, not a complete
answer. Text already streamed was authenticated by TLS record by record, so it
is the provider's; the late checks concern billing and the session binding.
Non-streaming requests receive one `chat.completion` only after every check.

**Pinned parameters.** The model, the token cap, `n`, `stream` and
`stream_options` always come from the session, whatever the request says. The
node's signed offer may pin further provider parameters, but only to values
that switch something off (Venice's `venice_parameters`, for example, turns
off Venice's own system prompt and web search). Clients refuse an offer that
pins anything else. A request that sets one of those parameters to the pinned
value is sent without it. A request that sets one to a different value is
refused with 400 (`error_type: pinned_parameter`), so your setting is never
silently replaced.

**Images.** `POST /v1/images/generations` (OpenAI shape) and
`POST /v1/image/generate` (Venice shape) with the same header run as
confidential image sessions on nodes whose signed offer lists
`capabilities: ["chat", "images"]`; others are refused with
`offer_no_images`, never served on the plain path. The node sees the model,
the priced variant (resolution tier, WebP) and the count (`n`/`variants`, up to
the offer's `max_count`); the prompt and the other options (`aspect_ratio`,
`seed`, `negative_prompt`, ...) stay private. The charge is the signed
`msat_per_image × count` plus the session fee, checked against the receipt.
The answer is OpenAI-shaped (`{created, data: [{b64_json}]}`) with the headers
`x-routstr-confidential-variant` and `x-routstr-cost-msats`; a provider error
keeps its status. Image requests are never pre-warmed: each one sets up its
own session (about 23 MB of 2PC traffic before the image).

Confidential requests are never written by the raw request/response logging
(`requestResponseLogging` or `ROUTSTRD_REQUEST_RESPONSE_LOG_DIR`): it would
store the prompt and the decrypted response in plaintext, so the SDK skips
its log sink for them. The daemon log records routing and settlement
metadata only, never the body.

Requires the `cu-prover` binary (build it
from <https://github.com/jooray/routstr-confidential>: `cd crypto && cargo build
--release -p zkbench --bin cu-prover`, binary in `crypto/zkbench/target/release/`),
and `cu-2pc` next to it. The SDK speaks only protocol v2 (the two-party
handshake over a joint P-256 key share); a node that still offers only the
retired protocol v1 is refused (`offer_unsupported_version`).

It also requires an SDK with the confidential transport, which no npm release
has yet (the daemon fails at startup with `Export named
'closeConfidentialPrewarm' not found`, and `bun run lint` fails on the same
name). Until one is released, build the SDK's `confidential-2pc` branch from
<https://github.com/jooray/routstr-sdk> next to this checkout and link it
before building:

```sh
(cd ../routstr-sdk && npm install && npm run build)
bun install
rm -rf node_modules/@routstr/sdk && ln -s "$PWD/../routstr-sdk" node_modules/@routstr/sdk
bun run build
bun link
```

## HTTP/2 connections (`http2`)

Prototype (protocol v3, option A). A node whose signed offer lists
`"http": ["1.1", "2"]` lets routstrd keep an HTTP/2 connection to the provider
open through it: one two-party handshake per connection instead of one per
request. The first confidential chat request to such a node opens a
connection, which costs what a cold request costs (the ~22 MB of two-party
preprocessing); it then stays open, and every later request on it skips the
handshake. Requests on one connection run one at a time, so a request that
arrives while every connection is busy opens another, up to `maxConnections`.
Nothing is opened ahead of traffic.

It is on by default and used only with nodes that offer it. Other nodes,
image requests and `xcashu` mode use the flow above (and `prewarm`).

```json
{
  "confidentialUpstream": {
    "enabled": true,
    "http2": {
      "enabled": true,
      "reuse": "credential",
      "maxConnections": 4,
      "maxTotal": 8,
      "maxIdleSeconds": 280,
      "maxRequestsPerConnection": 100
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` keeps every request on the v2 flow (one session per request, pre-warmed if `prewarm` is on) |
| `reuse` | `credential` | which requests may share a connection: `credential` (all requests to one node with your credential there), `model` (only requests for the same model), `none` (a new connection per request) |
| `maxConnections` | 4 | open connections per node and credential: the number of overlapping requests served without waiting for a free connection |
| `maxTotal` | 8 | open connections in total |
| `maxIdleSeconds` | 20 s less than the node's limit (300 s) | close a connection that has been idle this long |
| `maxRequestsPerConnection` | the node's limit (100) | close a connection after this many requests |

**Linkability.** Requests that share a connection share one TLS connection to
the provider, so the provider can tell they come from the same client. It
still sees the node's API key, not yours; without `http2`, each request is a
separate connection the provider cannot tell apart from other clients of the
node. The node sees your credential on every request in both modes. Use
`"reuse": "model"`, a low `maxRequestsPerConnection` or `maxIdleSeconds` to
link less, or `"enabled": false` for none.

**Failures.** A connection is closed after any error or non-2xx answer, when
idle, and at the node's limits; the next request opens a new one. If a kept
connection turns out to be dead when a request arrives, the request runs on a
new connection, as long as nothing of it was released towards the provider.
After that point a request is never repeated, on any connection or node.

**Funds.** An idle connection holds no reservation: the node reserves per
request, as for a request without `http2`. The pre-warm top-up rule (below)
does not apply to these requests.

Measured through routstrd on loopback (local node, real provider, a 20-token
answer; no bandwidth limit): the first request, which opens the connection,
reached the first token in 1.6 s and moved 23.7 MB to the daemon and 2.7 MB to
the node; the next four took 0.5-0.7 s and moved 0.5-1.0 MB and 85 kB each.
With `"enabled": false` the same requests took 1.7 s cold and 0.9-1.0 s
pre-warmed, and every one moved the full 23.7 MB / 2.7 MB (in the background
when pre-warmed). On a real link the difference is the download.

It needs the SDK's `confidential-v3` branch (see Enable for linking a local
SDK build) and a node on routstr-core `confidential-v3` with a sidecar whose
offer has an `h2` block.

Responses carry `x-routstr-confidential-http: 2` and
`x-routstr-confidential-connection: new|reused; request=<n>`. The daemon log
has one line per connection event and per request (`[confidential http2]`:
the connection, whether it was reused, time to the first token, bytes to and
from the node), without content or credentials.

## Pre-warming

Most of a cold request is the two-party
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
      "maxSessionFeeMsat": 5000,
      "fundsHeadroom": 2
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
| `maxAgeSeconds` | 480 | retire an armed session this long after its setup (the node ends a session 600 s after accepting its websocket; clamped to 60–570) |
| `maxSessionFeeMsat` | 5000 | pre-warm only nodes whose abandon fee (`abandon_fee_msat` in the signed offer: what an unused session costs) is at most this; `0` never pre-warms a node that charges one |
| `maxArmedWithFee` | 6 | armed sessions in total for nodes that charge an abandon fee. Raise it for parallel agents (subagents): each session that ends unused costs the fee. Keep it below the node's unused-sessions-per-address limit |
| `fundsHeadroom` | 2 | arm only while the credential's available balance on the node is at least this many reservations; the top-up keeps it 1.4 reservations above that (see Funds) |

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
node covers `fundsHeadroom` (default 2) times the last observed reservation R
(the new arm plus one cold request). While pre-warming is on, the automatic
top-up keeps (`fundsHeadroom` + 1.4) × R available, instead of the 1.4 × R a
cold request needs, so the session a request claimed is replaced while that
request is still running. The available balance excludes the armed sessions'
reservations, so with n armed sessions the key holds about
(n + `fundsHeadroom` + 1.4) × R at the node; `maxPerKey` and `maxTotal` bound
n. Lower `fundsHeadroom` (e.g. to 1) to keep less on the node. Too little
balance does not back the key off: it arms again when its next request
settles. An unused session is closed before the node's limit, and the node
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

**Failures.** A failed arm, and an armed session that dies before it is used
(the node or the network ended it, or it failed when a request claimed it),
pause arming for that key: 30 s, doubling up to 10 min. The count of dead
armed sessions resets only when a request served from an armed session
settles, so a node that keeps ending armed sessions costs a few arms (and
abandon fees), not one per minute.

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
