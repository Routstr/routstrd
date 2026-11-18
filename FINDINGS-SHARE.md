# routstrd 0.4.12 field test: findings

Tested on a real wallet against live nodes: 35 paid requests, about 140 sats, 3 nodes paid. Each finding has: what it means in plain words, whether a normal user can hit it (**practical**) or only in theory (**theoretical**), the exact command, what I got, and what it costs to repeat.

**What works:** Anthropic cache write and read are billed exactly at each node's listed rates (otrta and cypherpunk, `/v1/messages`, streaming, chat-completions format, Claude Code). Codex models on nostrmodels.top work for chat, streaming, the Responses API and tool calls, with billing exact to the msat. The upgrade kept the balance, nostrmodels turned on by itself, logs now redact keys, and refunds and parallel requests are fine.

## Quick verdict table

| # | Finding | Verdict | Whose bug | Cost to repeat |
|---|---|---|---|---|
| 1 | `routstrd update` times out on slow internet | Practical | routstrd | 0 |
| 2 | A bad request (400) refunds keys, hops 3 nodes, returns wrong error | **Intended behaviour, not a bug** | — | ~3 sats |
| 3 | Provider pin is not strict, prompt goes to other nodes on error | Practical (maybe by design) | SDK | ~10 sats |
| 4 | Sats on a mint the cheapest node rejects: 402, no failover | Practical | SDK | 0 |
| 5 | Responses API deposits are far too big | Practical (money parked, not lost) | SDK | ~0.1 sat + refund rounding |
| 6 | nostrmodels ignores max_tokens | Practical | node / upstream | ~0.2 sat |
| 7 | Default max_tokens 64000 blocks Claude for wallets under ~1.2k sats | Practical | routstrd default | 0 |
| 8 | Old installs stay on the fee mint after upgrade | Practical | routstrd | 0 |
| 9 | otrta Claude cache misses about half the time | Practical | upstream (ppq.ai) | ~21 sats per miss |
| 10a | "Model not offered" and "provider disabled" return 500 | Practical, cosmetic | routstrd | 0 |
| 10b | `history` shows a rolled-back receive as a normal receive | Practical, misleading | routstrd | 0 |
| 10c | 402 error JSON contradicts its own text | Practical, cosmetic | SDK | 0 |
| 10d | `models -m` shows context 4,096 from a disabled node | Practical, cosmetic | routstrd | 0 |
| 10e | Streaming Anthropic usage saved with 0 prompt tokens | Practical, cosmetic | upstream stream | ~2 sats |
| 10f | Responses stream final chunk has no `event:` line | Theoretical (no client broke) | node | ~1 sat |
| 10g | `history -i --json` prints full token strings | Low (tokens shown were spent) | routstrd | 0 |
| 10h | otrta's `claude-sonnet-5-5` costs 35% more than `claude-sonnet-5.5` | Practical, pricing | node | 0 |

## How to reproduce

Everything below runs against a local `routstrd` 0.4.12 on `127.0.0.1:8008`, in `apikeys` mode, with a wallet holding sats on minibits and cubabitcoin.

- To pin a node, add `-H "x-routstr-provider: <node>"`.
- The daemon does not check the `Authorization` header, so the curl commands leave it out.
- Check money before and after with `routstrd balance`. Pull parked sats back with `routstrd refund -y`.

---

## 1. `routstrd update` times out on slow internet

**Plain words:** the updater gives the whole 38 MB download only 30 seconds. On anything slower than about 1.3 MB/s it fails.

**Practical?** Yes. Any user on a phone hotspot or a weak connection. It failed for us.

**What I ran (on 0.4.11):**
```
routstrd update
```
**What I got:**
```
Updating routstrd from v0.4.11 to v0.4.12...
routstrd command failed: Could not update routstrd in place. The operation timed out.
```
Then I measured the same file with curl: it took 70 s at 540 KB/s. Checksum OK, manual install worked.

**Code:** `src/utils/standalone-update.ts` at tag v0.4.12. Line 16 `FETCH_TIMEOUT_MS = 30_000`. Line 66 puts `AbortSignal.timeout(FETCH_TIMEOUT_MS)` on the fetch. Line 168 reads the whole archive with `arrayBuffer()` under that same signal, so the 30 s covers the full download, not just the connection. "The operation timed out." is the abort message from that signal. The other 30 s timer (`PROCESS_TIMEOUT_MS`) would say "... timed out." with a label, so it was not that one.

**How you can check (free, no install):** time the download.
```bash
curl -sL -o /dev/null -w 'took %{time_total}s at %{speed_download} bytes/s\n' https://github.com/Routstr/routstrd/releases/download/v0.4.12/routstrd-v0.4.12-linux-x64.tar.gz
```
If it says more than 30 s, `routstrd update` would have failed on that connection.

---

## 2. A bad request (400) refunds keys, hops 3 nodes, returns the wrong error

> **STATUS: intended behaviour — do not fix.** Failover on an upstream error is deliberate: the same request may well succeed on another node (different upstream, different validation, different model build). The refund-then-hop is the cost of that reliability. The two sub-issues that are still real and worth a separate ticket: (a) `all_providers_failed` should carry the *first* provider's status/body rather than whichever node happened to error last, so clients see a 400 instead of a fallback 500, and (b) the hop count is unbounded by the pin/no-pin distinction (see #3).

**Plain words:** you send something the API rejects, like `temperature: "hot"`. That should just come back as a 400 and cost nothing. Instead the SDK pulls all your sats back from the node, tries 2 more nodes with fresh deposits (same 400 each time), pays mint fees on every hop, and in my run the final answer was an unrelated 500.

**Practical?** Yes. Agents and tools often send a parameter one provider does not like. Each time this costs fees and about 20 s.

**What I ran:**
```bash
curl -s -w '\nHTTP %{http_code}\n' -H 'Content-Type: application/json' -H 'x-routstr-provider: https://api.nostrmodels.top/' -X POST http://127.0.0.1:8008/v1/chat/completions -d '{"model":"gpt-6-luna","max_tokens":10,"temperature":"hot","messages":[{"role":"user","content":"hi"}]}'
```
**What I got:**
```
{"error":"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"}
HTTP 500
```
**What happened inside:**
1. nostrmodels: 400 "expected number" → "Status 400 (auth/server error), attempting refund" → refunded the whole key (28,437 msat).
2. "Failing over to next provider: https://routstr.otrta.me/" → 400 again → refunded that whole key too (9,092 msat).
3. "Failing over to next provider: https://llm.satsandsports.cash/" → the minibits mint dropped the socket while making the deposit → that error became the final answer.

Total balance went from 525.194 to 522.665 sats (about 2.5 sats gone) for a request that should cost 0. The failed minibits send was rolled back safely, so no proofs were stuck.

A second test with `"messages":"not-a-list"` did the same 3-node walk, but that time the final answer was the correct 400 (`all_providers_failed`). So the wrong-error part depends on luck. The refund-and-hop part happens every time.

**Cost to repeat:** about 2 to 3 sats in fees. You may get the correct 400 instead of the 500 if no mint hiccups.

**Verdict:** not a defect. Marked as intended on review. Errored-request failover is a product decision, and 2-3 sats is an acceptable price for it. Only the *error reporting* half is a bug — track it as "propagate upstream status, not the last node's failure" rather than as an SDK failover change.

---

## 3. Provider pin is not strict

**Plain words:** if you pin a node with `x-routstr-provider` (or the config `provider`), you would expect your prompt to go only there. On an upstream error the SDK still fails over to other nodes and sends them the same prompt.

**Practical?** Yes, I saw it with real Claude Code. It may be intended for reliability, but anyone pinning a node for privacy or trust would not expect it. This is a question for the team.

**What I ran:** Claude Code through routstrd with `ANTHROPIC_CUSTOM_HEADERS="x-routstr-provider: https://routstr.cypherpunk.today/"` and model `claude-sonnet-5-5`.

**What happened:**
- cypherpunk (Venice) answered 400: `system: text content blocks must contain non-whitespace text`.
- "Failing over to next provider: https://routstr.otrta.me/". Claude Code got its answer from otrta.
- `routstrd usage` shows that request under `https://routstr.otrta.me/`.

Test #2 shows the same thing with a plain curl and a pin to nostrmodels.

**Simple way to check:** repeat test #2 and look at the log for "Failing over to next provider" even though you pinned nostrmodels.


---

## 4. Sats on a mint the cheapest node rejects: 402, no failover

**Plain words:** the wallet has sats on two mints: most on minibits, a little on cubabitcoin. The cheapest node for gpt-6-astra (cypherpunk) only takes cubabitcoin. When the request needs more than your cubabitcoin balance, you get "insufficient balance" even though you have plenty in minibits, and nostrmodels (which takes minibits and sells the same model) is never tried.

**Practical?** Yes. Anyone whose sats are mostly on one mint will hit it on any model where the cheapest node does not take that mint.

**Needs an unpinned daemon** (no `provider` in config, no header). Then:
```bash
curl -s -w '\nHTTP %{http_code}\n' -H 'Content-Type: application/json' -X POST http://127.0.0.1:8008/v1/chat/completions -d '{"model":"gpt-6-astra","max_tokens":3000,"reasoning_effort":"low","messages":[{"role":"user","content":"Reply with just the word: ok"}]}'
```
**What I got:**
```
{"error":"Insufficient balance: need 100 sats, have 497 sats available. Largest mint balance: 434 sats from https://mint.minibits.cash/Bitcoin", ...}
HTTP 402
```
**Inside:** picks cypherpunk → sends a 105-sat minibits token → cypherpunk rejects the mint → token is reclaimed (safe) → cubabitcoin is short → 402. No "Failing over" line.

**Proof the other node works:** same request pinned to nostrmodels with `max_tokens: 500` returned "ok" for 0.28 sats.

**Cost to repeat:** 0. The minibits token goes out and comes back, and minibits has no fee.

**Smaller part of the same issue:** every top-up to cypherpunk tries minibits first and bounces before using cubabitcoin. Look for `topUp: mint https://mint.minibits.cash/Bitcoin failed ... retrying with another supported mint` in the log. It adds 2 to 4 s each time, no money lost.

---

## 5. Responses API deposits are far too big

**Plain words:** before a request, the SDK makes sure the node holds enough of your sats. For `/v1/responses` (what Codex uses) it ignores `max_output_tokens` and assumes the longest possible answer. So it moves far more sats to the node than the request needs. They are not lost (refund brings them back), but they sit on a third-party node.

**Practical?** Yes. Codex CLI uses Responses. With a bigger wallet, each new node will hold around 1,000 sats.

**What I ran:**
```bash
curl -s -H 'Content-Type: application/json' -H 'x-routstr-provider: https://api.nostrmodels.top/' -X POST http://127.0.0.1:8008/v1/responses -d '{"model":"gpt-6-luna","max_output_tokens":30,"input":"Write a 200-word paragraph about mints."}' | jq -c '.usage.cost.total_msats'
```
```bash
routstrd balance
```
**What I got:** the request cost 82 msat (0.08 sat). The nostrmodels key went from 6.358 to 55.276 sats, so 49 sats were moved for it.

Log: `required=38.9949 x 1.4` → `createProviderToken ... adjustedAmount=49`. The same request as chat completions estimated 0.014 sats.

**Bigger example:** gpt-6.1-sol on Responses, `max_output_tokens: 200`: `amount=778.04895` and a top-up of `1084` sats. The wallet was too small so the top-up failed, and then the node served the request from a 5.3-sat key for 0.62 sats. So the node never needed that money.

**Why:** in the SDK, `nodeGateSats` (`client/ProviderManager.ts`) says "The node ignores Responses `max_output_tokens`" and reserves the full completion budget. The sol request above shows the node actually served it from 5.3 sats, so that assumption looks wrong for these nodes.

**Cost to repeat:** about 0.1 sat, plus ~1 sat of rounding when you refund.

---

## 6. nostrmodels ignores max_tokens

**Plain words:** you ask for at most 30 tokens and get 277. Billing is for what you got, so the limit does not limit cost.

**Practical?** Yes, on nostrmodels. Cheap on luna, but on gpt-6-astra (0.029 sats per output token) a cap of 100 tokens could bill thousands. This is the node or its Codex upstream, not routstrd.

**What I ran:**
```bash
curl -s -H 'Content-Type: application/json' -H 'x-routstr-provider: https://api.nostrmodels.top/' -X POST http://127.0.0.1:8008/v1/chat/completions -d '{"model":"gpt-6-luna","max_tokens":30,"messages":[{"role":"user","content":"Write a 200-word paragraph about mints."}]}' | jq -c '[.choices[0].finish_reason, .usage.completion_tokens]'
```
**What I got:** `["stop",277]`. Responses with `max_output_tokens: 30` gave 274. A stream with `max_tokens: 1500` billed 1,787 tokens.

**Cost to repeat:** about 0.1 sat each.

---

## 7. Default max_tokens 64000 blocks Claude for small wallets

**Plain words:** if a client does not send `max_tokens`, routstrd fills in 64,000. The deposit for Claude is then sized for 64,000 output tokens, which needs about 1,200 sats in your wallet even for a "say hi" request.

**Practical?** Yes, for chat-completions clients that leave out `max_tokens` and wallets under about 1.2k sats. `/v1/messages` clients always send `max_tokens`, so they are not affected.

**What I ran:**
```bash
curl -s -w '\nHTTP %{http_code}\n' -H 'Content-Type: application/json' -H 'x-routstr-provider: https://routstr.otrta.me/' -X POST http://127.0.0.1:8008/v1/chat/completions -d '{"model":"claude-sonnet-5.5","messages":[{"role":"user","content":"Say hi in 3 words."}]}'
```
**What I got:**
```
{"error":"Insufficient balance: need 1207 sats, have 485.092 sats available. Largest mint balance: 476 sats from https://mint.minibits.cash/Bitcoin","error_type":"insufficient_balance","required":1207,"available":485,"maxMintBalance":0,"maxMintUrl":""}
HTTP 402
```
The same request with `max_tokens: 20` worked and cost 0.2 sats.

**Cost to repeat:** 0.

---

## 8. Old installs stay on the fee mint after upgrade

**Plain words:** 0.4.12 makes Minibits (no fee) the default mint, but only for new installs. An upgraded wallet still sends from cubabitcoin, which charges 100 ppk (0.1 sat per proof, rounded up). Small deposits and refunds lose 1 to 2 sats each.

**Practical?** Yes. About 22 of my 141 sats went to fees, rounding and the #2 loop.

**Check (free):**
```bash
routstrd wallet status | jq '{activeMint, defaultMint}'
```
```bash
curl -s https://mint.cubabitcoin.org/v1/keysets | jq -c '[.keysets[]|select(.active)|{unit,input_fee_ppk}]'
```
```bash
curl -s https://mint.minibits.cash/Bitcoin/v1/keysets | jq -c '[.keysets[]|select(.active)|{unit,input_fee_ppk}]'
```
I got activeMint and defaultMint = cubabitcoin, cubabitcoin fee 100, minibits fee 0.

**Example from history:** a 7-sat send left the wallet 8 sats lighter, and the node credited 6 sats.

---

## 9. otrta Claude cache misses about half the time

**Plain words:** otrta sends Claude through ppq.ai. Same prompt, same cache marker, and about half the time it writes the cache again (~21 sats) instead of reading it (~2 sats). cypherpunk hit every time.

**Practical?** Yes, and it is where most of my sats went. But it is upstream, not routstrd. Billing was correct for what upstream reported.

**My results:**

| Request | Result | Charged |
|---|---|---|
| cache-write (otrta) | write 6,740 | 20.99 sats |
| cache-read, 20 s later (otrta) | **write again** | 21.00 sats |
| otrta-cache-repeat, same body | read | 1.94 sats |
| otrta-cache-q2, other question | read | 1.94 sats |
| otrta-cache-stream, `stream: true` | **write again** | 21.03 sats |
| cp-cache1 / cp-cache2 (cypherpunk) | write, then read | 13.5 then 3.4 sats |

**Cost to repeat:** 2 to 21 sats per request. I would skip it unless you want to see it yourself.

---

## 10. Smaller things

**10a. Wrong status codes (cosmetic, free):**
```bash
curl -s -w ' HTTP %{http_code}\n' -H 'Content-Type: application/json' -H 'x-routstr-provider: https://api.nostrmodels.top/' -X POST http://127.0.0.1:8008/v1/chat/completions -d '{"model":"no-such-model-xyz","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}'
```
Got `{"error":"Provider https://api.nostrmodels.top/ does not offer model: no-such-model-xyz"} HTTP 500`. Pinning a disabled node (for example `https://api.routstr.com/`) also gives 500. These should be 4xx.

**10b. History shows a receive that never happened (free):**
```bash
routstrd history -n 20
```
Row 91 shows `RECEIVE | cubabitcoin | 14 sat`. But:
```bash
routstrd history -i 91 --json | jq '{type, amount, state}'
```
shows `"state": "rolledBack"`. The table view does not show state, so it looks like money arrived.

**10c. 402 JSON contradicts its text:** see #7. The text says "476 sats from minibits", but minibits had 448 (476 was both mints together), and the JSON fields say `maxMintBalance: 0, maxMintUrl: ""`.

**10d. Wrong context size in `models -m` (free):**
```bash
routstrd models -m gpt-6.1-sol | head -4
```
Shows `Context: 4,096 tokens`. `/v1/models` says 922,000. The header seems to come from the first listed node (blazelight, disabled).

**10e. Streaming Claude usage saved with 0 prompt tokens:** after `otrta-cache-stream`, `routstrd usage` showed `promptTokens: 0` (cache tokens and cost were right). The upstream stream sends `input_tokens: 0`. Cosmetic.

**10f. Responses stream missing `event:` line (theoretical):** in a streamed gpt-6.1-sol Responses call, every chunk has an `event:` line except the final `response.completed` one (the node rewrites it to add cost). Clients that read the JSON `type` field are fine. Only a strict client keyed on `event:` would break. I did not see one break.

**10g. `history -i <id> --json` prints full token strings.** The ones I looked at were already spent. For a still-pending send it would show a live token, which is the point of that command. Low risk.

**10h. otrta pricing (node side, free):**
```bash
curl -s https://routstr.otrta.me/v1/models | jq -r '.data[]|select(.id|test("sonnet-5"))|"\(.id) in=\(.pricing.prompt) cache_write=\(.pricing.input_cache_write)"'
```
`claude-sonnet-5-5` is $3/M input, `claude-sonnet-5.5` is $2.2155/M. Claude Code used the dash id, so it paid about 35% more on otrta. otrta also adds its markup to input but not to cache rates (cache read is exactly 0.1x of the base price before markup).

---

## Things I did not test
- Failover from a truly dead node. I could not trigger it without sending real tokens to a fake node.
- xcashu mode, NWC funding, Lightning send or receive, the monitor TUI, real pi or opencode runs.
