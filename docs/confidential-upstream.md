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
keeps its status. An image request runs on an open framing-"2" connection
when the node's offer serves images there, else on a framing-"1.1"
connection of its own; an armed connection serves it too.

Confidential requests are never written by the raw request/response logging
(`requestResponseLogging` or `ROUTSTRD_REQUEST_RESPONSE_LOG_DIR`): it would
store the prompt and the decrypted response in plaintext, so the SDK skips
its log sink for them. The daemon log records routing and settlement
metadata only, never the body.

Requires the `cu-prover` binary (build it
from <https://github.com/jooray/routstr-confidential>: `cd crypto && cargo build
--release -p zkbench --bin cu-prover`, binary in `crypto/zkbench/target/release/`),
and `cu-2pc` next to it, of the same release as the node's sidecar (else
requests fail with `twopc_version_mismatch`).

**Protocol version.** routstrd speaks routstr-confidential protocol **v3**
only and asks for offers as `/v1/confidential/offer?v=3`. A node whose offer
names an older version is not used for confidential requests; the daemon
logs `node_protocol_outdated: <node> offers routstr-confidential v2 …` once
per node per day, and when no other node can serve the request the error
body says so (`error_type: "node_protocol_outdated"`, status 502). A node
that is newer than the daemon answers `upgrade_required` (update routstrd).

It also requires an SDK with the confidential transport, which no npm release
has yet (the daemon fails at startup with `Export named
'closeConfidentialConnections' not found`, and `bun run lint` fails on the same
name). Until one is released, build the SDK's `confidential-v3` branch from
<https://github.com/jooray/routstr-sdk> next to this checkout and link it
before building:

```sh
(cd ../routstr-sdk && npm install && npm run build)
bun install
rm -rf node_modules/@routstr/sdk && ln -s "$PWD/../routstr-sdk" node_modules/@routstr/sdk
bun run build
bun link
```

## Connections, framings and reuse

A confidential request runs on a **connection** through the node to the
provider. Its framing towards the provider is `"2"` (HTTP/2: the connection is
kept and serves many requests one after another, after one two-party
handshake) or `"1.1"` (HTTP/1.1: a connection per request). Your local API does
not change either way.

```json
{
  "confidentialUpstream": {
    "enabled": true,
    "http": "auto",
    "maxConnectionDepositMsat": 100000,
    "http2": { "reuse": "per-client", "maxConnections": 4, "maxTotal": 8 },
    "prewarm": { "enabled": true }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `http` | `auto` | `auto`: the first framing the node's signed offer lists (the operator's preference); when a framing-`"2"` connection fails before the request's body was sent (handshake, ALPN, the provider closing, the node's `h2_withdrawn`), the request is served on `"1.1"` on the same node and `"2"` is not tried there for 10 minutes (`framing "2" marked bad` in the log). `"2"` or `"1.1"`: only that framing; a node that does not offer it is not used |
| `maxConnectionDepositMsat` | 100000 | the largest connection deposit accepted (below). A node asking for more is not used (`http2.maxConnectionDepositMsat`, its earlier place, is still read) |
| `http2.reuse` | `per-client` | which requests may share a framing-`"2"` connection. `per-client`: the requests of one local client, i.e. one API key in the `Authorization` (or `x-api-key`) header, or without one the caller's address; `shared`: every request of the daemon to that node; `none`: a connection per request |
| `http2.maxConnections` | 4 | open connections per node, credential and client: overlapping requests are served on separate connections without waiting up to this many |
| `http2.maxTotal` | 8 | open connections in total |
| `http2.maxIdleSeconds` | node's `idle_timeout_s` − 20 s | close an idle connection after this; never longer than the node allows |
| `http2.maxRequestsPerConnection` | the node's `h2.max_requests` | close a connection after this many requests |

**Linkability.** The requests of one connection share one TLS connection to
the provider, so the provider (and its CDN, and anyone watching the node's
traffic to it) can tell they come from one client, in order. With the default
`per-client`, *every* request made with one local API key is connection-
linkable in this way, across conversations and applications that share the
key; `per-client` only keeps two local clients (two agents, two users of a
shared daemon) apart. Narrower choices:

- a request header `x-routstr-reuse-scope: <any string up to 256 bytes>`
  (one per conversation, say) puts the request in its own partition within
  its client's (under `shared`: within the daemon's) connections; it can only
  narrow, never widen, what is shared;
- `http2.reuse: "none"` gives every request its own connection;
- `http: "1.1"` (framing "1.1", one request per connection) turns HTTP/2 off
  for confidential requests altogether.

**The connection deposit.** A node reserves `connection_deposit_msat` (its
signed offer) when a connection is set up and releases it with the
connection's first settled request (its receipt says so). A connection that
ends without a settled request loses it, unless the node, its sidecar or the
provider failed. So the balance a request needs before a connection opens is
the deposit plus the request's reservation (a full-context prompt plus
`max_tokens` at the offer's rates, plus the larger of the session and abandon
fees); routstrd tops up for that. The session fee is charged once per
connection, with its first request.

**Refused requests.** When the node refuses a request (402 for the balance,
a model it does not serve, an expired offer), the caller gets the node's
error and the connection stays open: nothing was held for the request, and
the next one runs on the same connection.

Responses carry `x-routstr-confidential-http` (the framing) and
`x-routstr-confidential-connection` (`new`, `armed` or `reused`, and the
request's number on its connection). The daemon logs one line per request
(`[confidential] request {...}`: framing, what it found, time to first
token, bytes each way), without content or credentials.

## Pre-warming

Most of a cold request is the two-party preprocessing (about 18 MB from the
node and 2.5 MB to it). routstrd can run it before a request arrives: an
**armed connection** has the deposit held, the preprocessing, the key share
and the proof setup done, and no provider connection yet. It is bound to the
credential only (not to a model or a body length).

- Framing `"1.1"`: one armed connection per (node, credential, client) while
  that key has traffic.
- Framing `"2"`: one armed connection per key while it has traffic **and every
  open connection of it is busy**, so a burst does not wait for a handshake.
  A single client sending one request at a time reuses its open connection
  and needs none.

It is on by default and only reacts to traffic (a key is armed only after one
of its requests settled, one arm at a time); an idle routstrd keeps none.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns pre-warming off |
| `activityWindowMinutes` | 10 | a key with no request in this window keeps no armed connection; one it holds is closed |
| `maxTotal` | 4 | armed connections in total. Nodes limit unused connections per client address (default 12, `CONFIDENTIAL_MAX_UNUSED_PER_IP`); keep this below |
| `maxAgeSeconds` | 480 | retire an armed connection this long after its setup (the node ends it after 600 s; clamped to 60–570) |
| `maxDepositMsat` | 5000 | pre-warm only nodes whose connection deposit (what an armed connection that is never used costs) is at most this; `0` never pre-warms a node that takes one |

An armed connection that is retired unused loses its deposit; routstrd logs
each (`retiring armed … unused …; its deposit of N msat is charged (M msat
for unused spares so far)`). A failed arm, or an armed connection that died
before it was used, pauses arming for that key (30 s, doubling up to 10 min);
too little balance for the deposit retries after 30 s without escalating.
Pre-warming is not used for one-off Cashu bearers (`xcashu` mode): they run
on framing `"1.1"` (a connection per token), or `"2"` with a connection of
their own.

Measured on loopback against Venice (time to first token at the local API):
a cold request 1.3–1.9 s, a request on an open framing-`"2"` connection
0.5–1.0 s, a request served by an armed connection about as fast as on an
open one plus its handshake. On a slow link the cold case is dominated by the
~18 MB of preprocessing that pre-warming moves off the request path.
