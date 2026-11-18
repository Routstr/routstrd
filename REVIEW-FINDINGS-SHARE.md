# routstrd 0.4.12 code review + break-it tests: findings not in the field test

This complements `FINDINGS-SHARE.md` (the live field test). It covers only the findings the field test did **not** have. I left out the 3 overlaps: the fee mint after upgrade, 500 instead of 4xx, and the wrong context size in `models -m`.

## How I tested

The field test used a real wallet against live nodes. I did the opposite: no real sats, and a fake version of everything outside routstrd, so I could make each part misbehave on purpose. That is why these findings sit in areas the field test skipped: NWC, wallet recovery, fresh onboarding, and broken inputs.

**1. Reading the change.** I read the full v0.4.11 → v0.4.12 diff (46 commits, PRs #110–#118) in a clean checkout of the v0.4.12 tag. I compared it with what each PR description promised and with the repo docs. Every finding below was checked against the actual code, not only the diff.

**2. Real routstrd, fake world around it.** I ran the real routstrd daemon and the real CLI from the v0.4.12 tag. Each test got a brand-new data directory and its own port, so nothing touched a real wallet or a running daemon. Around it I put small stand-ins I wrote for the test:
- **A fake Cashu mint**, built on the test mint that ships in the routstrd repo. I could make it answer normally, go offline, answer slowly (25 s or more), return errors or broken JSON, or answer its "are you alive" ping but hang on real work.
- **A fake Nostr relay** that could stay silent, drop the connection at once, answer after a long delay, or flood huge messages.
- **A fake NWC wallet** (a real NWC wallet service with throwaway keys) connected through that relay. I could set how long it waits before answering a payment.
- **A fake AI provider**, so chat requests never went to real nodes.
- **A fake daemon** for testing the CLI alone. It could hang, trickle one byte every few seconds, send an endless response, or never answer the health check.

**3. Trying to break it.** For each new feature I wrote down how it could go wrong, then built that situation:
- Crashing the wallet between "invoice paid" and "tokens issued".
- Running two recoveries at the same time.
- Taking a mint down and bringing it back during recovery.
- Making the NWC wallet slower than the new timeouts.
- Restarting with work still pending.
- Sending broken, `null` or very large request bodies.
- Feeding the new history and provider commands bad numbers and typos.

Each time I recorded balances and proof counts before and after, timings, exit codes, memory use, and the daemon log.

**4. Rating.** For each finding I judged whether a normal user can hit it (**practical**) or only under contrived conditions (**theoretical**), and how bad it is (P0 = wallet stops or money at risk, P1 = wrong behaviour users will see, P2 = edge case or polish).

## What works
- **No double-minting.** I tried a crash in the middle of minting, two recoveries at once, the background sweep racing a manual recover, and two daemons on one wallet file. Every case ended with exactly one issue and the right balance.
- **Slow mints:** a mint answering in 25 s times out cleanly and the quote is recovered later.
- **NWC status:** `nwc status` always gave up after 30 s, whether the relay was silent, dropped the connection, answered late or flooded. Six at the same time also finished.
- **CLI limit:** the CLI's 120 s limit fires correctly when the daemon hangs or trickles.
- **Doubled paths:** `/v1/v1/...` paths are fixed correctly.
- **Provider re-sync:** re-syncing providers with Nostr fails safe when relays are down.

## Quick verdict table

| # | Finding | Verdict | New in 0.4.12? | Severity |
|---|---|---|---|---|
| 1 | Auto-refill pays a fresh invoice after every NWC timeout, ignoring cooldown | Practical (NWC + auto-refill users) | Yes (#117) | P1 |
| 2 | A half-broken mint freezes sends to **every** mint until restart | Theoretical | Gap left by #112/#116 | P0 |
| 3 | `nwc status` timing out can kill a payment in flight | Practical | Yes (#117) | P1 |
| 4 | `nwc fund` timeout: 500, no invoice, no "may still have paid" warning | Practical | Yes (#117) | P2 |
| 5 | Fresh install can't onboard while Minibits is down | Practical (during a Minibits outage) | Yes (#113) | P1 |
| 6 | Promised 5-minute recovery recheck doesn't exist | Practical | Missing from #112/#116 | P1 |
| 7 | One failed recovery blocks the whole wallet until restart | Practical, rare | Not fixed, though the PR said it would be | P2 |
| 8 | Recovery warning text is wrong; `nwc status` exits 0 when disconnected | Practical, cosmetic | Yes | P2 |
| 9 | `wallet balance` says `UNLOCKED` while recovering | Practical, cosmetic | No | P2 |
| 10 | `wallet recover` can run past the CLI's 120 s limit | Practical with many slow quotes | Yes (#114) | P2 |
| 11 | `providers nostr-sync <n>` can hit the wrong provider | Practical | Yes (#110) | P2 |
| 12 | `/wallet/history`: negative limit returns everything, a typo'd type returns `[]` | Practical, API only | Partly | P2 |
| 13 | Cooldowns shown for the whole model when only one model path is cooled down | Practical, misleading | Yes | P2 |
| 14 | No size limit on request bodies (daemon grew to 1.28 GB) | Practical for buggy local clients | No | P2 |
| 15 | `null` request body hangs the connection 30 s | Theoretical | No | P2 |
| 16 | CLI with a remote `daemonUrl` hangs ~5 min on `/health` | Theoretical | No | P2 |
| 17 | CLI reads unlimited response body (2.28 GB) | Theoretical | No | P2 |
| 18 | Release hygiene: test helper ships in npm, SKILL.md out of date, #111 scope creep | n/a | Yes | P1/P2 |

Line numbers below refer to the `v0.4.12` tag.

---

## 1. Auto-refill pays again after every NWC timeout

**Plain words:** 0.4.12 gives an NWC payment 45 s to answer. When it doesn't, auto-refill treats that like a network hiccup. About 5–10 s later it creates a **new** invoice and pays that too. The cooldown you set (say 1 hour) only applies after a *successful* refill, so it doesn't stop this. If the first payment was just slow and lands later, each retry spends another refill amount from your NWC wallet. The sats end up in your own Cashu wallet, so nothing is lost, but one refill can charge you several times.

**Practical?** Yes, for anyone with auto-refill on and a wallet that is sometimes slow to answer, such as a phone wallet in the background or a busy relay. Before 0.4.12 a stuck payment just hung forever, so this repeat loop is new. The code even says "callers must reconcile before trying a fresh invoice", and the NWC docs say "payments are never automatically retried". Auto-refill doesn't follow either.

**How I tested:** I connected a fresh daemon to the fake NWC wallet, set to wait 60 s before answering any payment, which is just over the new 45 s limit. I turned on auto-refill with a 500-sat threshold, a 100-sat amount and a one-hour cooldown, starting from an empty Cashu wallet so it would want to refill right away. Then I watched the daemon log and counted how many invoices it created and how many payment requests reached the wallet.

**What I got:** the log showed "NWC payment timed out", then "next in 5s", then "Creating BOLT-11 invoice" again. In about 3 minutes: 4 invoices and 4 payment requests, despite the one-hour cooldown.

**Code:** `src/daemon/wallet/auto-refill.ts:149-185`. The error handler only sets a long pause for "fatal" messages such as an empty wallet. "NWC payment timed out" isn't one of them, so the next check goes ahead.

**Fix idea:** treat a timeout as "outcome unknown". Start the full cooldown, or check the last refill's mint quote before paying again.

---

## 2. A half-broken mint freezes sends to every mint

**Plain words:** at startup the wallet pings each mint (2 s limit) and skips the ones that don't answer. A mint that **does** answer the ping but then hangs when asked about pending quotes slips through. The wallet waits on it forever, and until that finishes, sends and receives at **all** mints are blocked, including healthy ones. Stopping the daemon takes over a minute and a half.

**Practical?** Theoretical. You need a mint quote still pending from before a restart, plus a mint that is half-down (its front page answers, the rest hangs), which does happen during mint incidents. But when it happens it is the worst single effect I found: the whole wallet stops.

**How I tested:** I ran two fake mints. Mint A answered the ping normally but never replied to quote checks; mint B was healthy and held 100 sats. I gave the wallet a pending quote at mint A, stopped it, and started a real daemon on that wallet. Then I used the CLI to send 10 sats **from mint B** (the healthy one) and timed it. Next I fixed mint A to see whether the wallet recovered by itself. Finally I asked the daemon to stop and timed that too.

**What I got:**
- **The send:** it printed "Wallet is recovering… send and receive resume as soon as recovery completes" and then hung for 1 min 53 s until I killed it.
- **Recovery:** still stuck at "Mint recovery" after 60 s, and fixing mint A did not unstick it.
- **Stopping:** the stop command printed "Still finishing ongoing requests…" for over a minute and took 92 s in total.

**Code:** `src/daemon/wallet/coco-client.ts:1802`. The all-mints recovery call has no time limit. The safer per-mint recovery only runs when the ping already failed.

---

## 3. `nwc status` timing out can kill a payment that is in progress

**Plain words:** when a status check takes over 15 s, routstrd rebuilds the NWC connection and closes the old relay connections. A payment already in flight (an auto-refill or `nwc fund`) was waiting for its answer on those connections. It never gets the answer, so it reports "timed out" even if the wallet paid, which then triggers finding #1.

**Practical?** Yes, if you check status while a refill is running and the relay is slow.

**How I tested:** this one I confirmed by reading the code, not end to end. I followed what happens on a status timeout: the connection is rebuilt and the old relay pool is closed, and in-flight requests use that same pool. The docs say wallet *errors* deliberately don't rebuild "because rebuilding could interrupt unrelated payments". Timeouts do it anyway, and the new tests only cover the error case.

**Code:** `src/daemon/wallet/index.ts:180-185, 211-213`.

---

## 4. `nwc fund` timeout hides that you may have paid

**Plain words:** if funding over NWC times out, you get a plain "NWC payment timed out" and an error status. You get no invoice to check and no warning that the payment may still go through, so most people will just run it again and pay twice.

The opposite mistake also happens: a read-only `nwc status` against a stuck daemon *does* print "any payment outcome is unknown — check before retrying", even though nothing was being paid.

**How I tested:** I pointed a fresh daemon at the fake relay set to stay silent, so the NWC wallet never answers, and ran `nwc fund` for 10 sats from the CLI. I then checked the message, the exit code, the response body and the timing. For the reverse case I ran `nwc status` against the fake daemon that never answers.

**What I got:** after 45.1 s, "NWC payment timed out" and exit code 1. The response had an empty invoice and no operation id.

**Code:** `src/daemon/wallet/index.ts:298-323`, `src/daemon/http/index.ts:875`.

---

## 5. Fresh install can't onboard while Minibits is down

**Plain words:** 0.4.12 made Minibits the default mint. On a brand-new wallet, startup insists on reaching Minibits. If it can't, onboarding fails, even though cubabitcoin (the second built-in mint) is fine.

**Practical?** Yes, but only during a Minibits outage or on a network that blocks it. It is also why 8 of the project's own tests fail offline: they talk to the real Minibits.

**How I tested:** I ran onboarding in a brand-new empty home directory on a machine that could not reach Minibits, with integrations skipped so only the wallet setup ran. Then I pointed the new wallet's default mint at my fake mint and onboarded again, to confirm Minibits was the only cause.

**What I got:** "Adding default mint: https://mint.minibits.cash/Bitcoin", then "routstrd command failed: Failed to fetch mint https://mint.minibits.cash/Bitcoin", exit code 1. With the fake mint as default it started fine.

**Code:** `src/daemon/wallet/trusted-mints.ts`. If the default mint fails, startup stops; if the other built-in mint fails, it only logs an error.

**Fix idea:** fall back to the next built-in mint, or start in a "mint unavailable" mode.

---

## 6. The promised 5-minute recovery recheck doesn't exist

**Plain words:** PR #112/#116 says that when a mint was down at startup, its stuck sends and melts are "recovered when the mint answers again — now within 5 minutes instead of next restart". There is no such timer. Only *mint* quotes get retried in the background. Sends and melts stay stuck, with their sats reserved, until you restart. A manual endpoint exists (`POST /wallet/recover/operations`), but no CLI command calls it.

**Practical?** Yes: restart while a mint is down, then the mint comes back.

**How I tested:** I compared the PR description with the code. I searched the source for the recheck timer the PR names and for any 5-minute interval, and found neither. I then traced what *does* run in the background (the pending-mint-quote sweep only) and which CLI commands exist for recovery.

---

## 7. One failed recovery blocks the whole wallet until restart

**Plain words:** the PR listed this as a problem being fixed: "recovery phase throws → every send fails 'Wallet is not ready' until daemon restart". It is still the case. When recovery fails, the gate stays shut for every mint and nothing reopens it.

**How I tested:** by reading the code. The gate's "failed" state is permanent: it rejects every later caller for every mint and has no reset.

**Code:** `src/daemon/wallet/coco-client.ts:1652, 1675`.

---

## 8. Misleading recovery message and exit code

- **Wrong promise:** during recovery, `send` and `receive` print "send and receive resume as soon as recovery completes". When only one mint is bad, sends to healthy mints actually go through right away. In #2, recovery never completes at all. The message should name the mint and say "restart if stuck".
- **Exit code:** `nwc status` exits with success (0) when it prints `"connected": false`, so scripts can't tell it failed.
- **Missing warning:** `nwc fund` doesn't show the recovery warning at all.

**How I tested:** I compared the messages with what actually happened in the #2 and #4 test runs, and checked the exit code of every `nwc status` run against the silent relay.

---

## 9. `wallet balance` says UNLOCKED while recovering

**How I tested:** during the stuck-recovery run from #2, I asked for `wallet balance` and `wallet status` at the same moment.

**What I got:** balance reported the wallet as `UNLOCKED` while status said `RECOVERING`. This was already the case in 0.4.11 (`http/index.ts:521`). Balance should report the real state.

---

## 10. `wallet recover` can outlast the CLI

**Plain words:** manual recovery checks quotes one after another, giving each up to 20 s, with no overall limit. It also accepts any timeout you pass. With 7 or more slow quotes, the CLI gives up at 120 s and prints "payment outcome unknown" while the daemon keeps working in the background.

**How I tested:** by reading the code. I added up the per-quote limits against the CLI's 120 s limit, and checked that this route isn't on the CLI's list of long-running routes, which get longer.

**Code:** `src/daemon/wallet/coco-client.ts:2605`, `src/utils/daemon-client.ts:77`.

---

## 11. `providers nostr-sync <n>` can hit the wrong provider

**Plain words:** provider commands use the position in the list. Refreshing the provider list can reorder it, so the number you just looked at can point at a different provider.

**Practical?** Yes. List, something refreshes in between (you, or the daemon on its own), then act.

**How I tested:** on a fresh daemon connected to read-only Nostr relays, I listed providers and noted one provider's number. I asked the daemon to refresh, listed again, and ran `providers nostr-sync` with the old number.

**What I got:** the provider I noted moved from position 1 to position 2. The command reset a different provider.

**Fix idea:** accept the provider URL, or have the CLI send the URL it displayed.

---

## 12. `/wallet/history` input not checked

**Plain words:**
- **Negative limit:** asking the history API for a negative number of entries returns the **whole** history. SQLite treats a negative LIMIT as "no limit".
- **Unknown type:** a misspelled entry type (e.g. "sned") isn't rejected. The daemon quietly scans everything and returns an empty list, which looks like "no history". The CLI rejects bad types, but the HTTP API doesn't.
- **id with type:** asking for one entry by id *and* a type ignores the type.

The CLI's history limit option also accepts negative numbers.

**How I tested:** I sent the history endpoint a range of bad inputs: negative, zero, huge and non-numeric limit/offset, misspelled types, SQL-looking strings, and id+type combinations. I compared what came back with what the CLI allows.

**Code:** `src/daemon/http/index.ts:717-737`.

---

## 13. Cooldowns look wider than they are

**Plain words:** when one *model path* fails twice (for example a pinned path, or one picked by the new `autoModelPath`), only that path is cooled down. The model's other paths keep working. But the `cooldowns` output drops the path and shows the **whole model** as blocked. Two path cooldowns on one model show as two identical rows.

**How I tested:** I seeded the cooldown store with path-level entries the same way the SDK writes them. Then I compared the daemon's `/cooldowns` output and the CLI's `cooldowns` output with what the SDK actually blocks.

**Code:** `src/utils/cooldowns.ts:57-66`.

---

## 14. No size limit on request bodies

**Plain words:** the daemon reads any request body fully into memory. A buggy client or script on your machine can push it to gigabytes, and the memory isn't given back afterwards.

**How I tested:** I streamed a 300 MB body into a provider endpoint on a fresh daemon and watched its memory before, during and after.

**What I got:** daemon memory went from 265 MB to 1.28 GB and stayed there after it answered "bad request".

---

## 15. A `null` body hangs the connection

**Plain words:** if a chat request's body is the JSON value `null` instead of an object, the daemon hits an error it doesn't catch and never answers that connection. The daemon itself stays up.

**Practical?** Theoretical: real clients don't send `null`.

**How I tested:** I sent `null` as the body of a chat-completions request to a fresh daemon and waited up to 30 s.

**What I got:** no answer at all until my client gave up. The daemon log showed "UNHANDLED REJECTION: null is not an object (evaluating 'bodyObj.model')".

**Code:** `src/daemon/http/index.ts:2030`.

---

## 16. CLI hangs ~5 min with a remote daemon that won't answer the health check

**Plain words:** when the CLI is set to talk to a daemon on another machine (`daemonUrl`), its first "is the daemon alive" check has no timeout. The local path has a 2 s one. A remote daemon that accepts the connection but never replies leaves the CLI stuck until Bun's own ~300 s network timeout.

**How I tested:** I pointed the CLI's `daemonUrl` at the fake daemon set to accept connections but never answer the health check, ran `nwc status`, and timed it.

**What I got:** still stuck at 200 s, when my test watchdog killed it. An earlier run printed "Daemon is not reachable" only after about 300 s.

**Code:** `src/utils/daemon-client.ts:220`.

---

## 17. CLI reads any size of response

**Plain words:** the CLI reads the daemon's answer with no size cap. Only a broken or hostile daemon would send something huge, but nothing stops it.

**How I tested:** I pointed the CLI at the fake daemon set to send an endless response and measured the CLI's peak memory.

**What I got:** the CLI reached **2.28 GB** of memory before its 120 s limit stopped it.

**Code:** `src/utils/daemon-client.ts:155-158`.

---

## 18. Release hygiene (no runtime impact)

Found by reading the diff against the repo's conventions and the PR descriptions.

- **Test code ships to users:** the fake mint used in tests is in the npm package, because the package only excludes the `wallet/fixtures` folder.
- **SKILL.md (the CLI reference) is out of date:**
  - Not documented: `wallet recover`, `providers nostr-sync`, `wallet cleanup --force`, the `autoModelPath` setting.
  - It still says expired mint quotes are always marked failed.
  - The provider list sample shows the old labels.
- **#111 did more than agreed:** it was meant to touch only `gpt-*` models. It also forces `claude*` models onto the Anthropic API format, overwriting what the user set, and it moves pi's base URL off `/v1`.
- **The recovery doc contradicts the release:** `docs/wallet-mint-recovery.md` says no new issuance code is needed, but #114 added it. It also calls #118 a later follow-up, though #118 is in this release.
- **Size limits:** `coco-client.ts` (2,657 lines), `cli.ts` and `http/index.ts` grew further past the 800-line guideline. One new function is about 210 lines.

---

## Things I did not test
- Anything with real sats or live nodes (the field test covers that).
- SDK routing, failover, deposit sizing and billing.
- xcashu mode, Lightning send and receive, the monitor TUI, real pi or opencode runs.
- #3, #6, #7 and #10 were confirmed in code only, not run end to end.
