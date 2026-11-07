# NPC transport lifecycle patches

These version-scoped Bun patches cover `npubcash-sdk@0.3.2` and
`coco-cashu-plugin-npc@2.4.1`. `bun install --frozen-lockfile` applies them;
re-evaluate/remove them when upgrading either dependency. Both distributed
ESM and CommonJS entry points are patched, together with their declarations.
No global fetch replacement or application access to private SDK fields is used.

- SDK constructors accept optional `NPCRequestOptions` (`requestTimeoutMs`,
  `signal`). Every SDK HTTP request defaults to a 10-second deadline. The timer
  remains active through body consumption, including non-success responses;
  the response is buffered before existing JSON/error handling runs. Successful
  authentication, headers, pagination, and retry behavior stay unchanged.
- The plugin supplies one lifetime abort signal to both its JWT provider and
  API client, and aborts it before awaiting its sync runner during shutdown.
  Authentication and quote fetches already in progress are canceled; subsequent
  page requests cannot start network work. `requestTimeoutMs` is available on
  plugin options, primarily to test cancellation independently of the deadline.

The deadline is **per HTTP request**, not per complete sync: a large paginated
history may legitimately take longer than 10 seconds. Shutdown cancellation
applies across all those pages (pagination's existing 200ms sleep is not canceled).
This does not bound external signers or mint-service imports. The daemon signer
is local; an in-flight Cashu mint operation still follows the wallet/core's
existing recovery and shutdown contracts. This patch must not be represented as
an unconditional 30-second bound on every possible wallet operation.

`src/daemon/wallet/npc-transport.test.ts` uses loopback HTTP, real SDK requests,
and both real plugin builds. It covers authentication and quote stalls before
headers and during bodies, deadline recovery, body-stream cancellation,
shutdown cancellation independent of the deadline, and successful pagination.
The separate mocked wallet integration test explicitly holds recovery and
verifies that disposal prevents a startup catch-up; it does not test transport.

## Coco local-only send handlers

`@cashu/coco-core@1.0.1` is pinned and patched in both ESM/CommonJS builds
and their declarations. Send handlers can opt out of wallet loading with
`requiresWallet: false`. Such handlers receive `undefined` for `ctx.wallet`
in prepare, execute, pending checks, executing recovery and prepared rollback.
Pending reclaim still loads a wallet: reclaiming a shared token requires the mint.
Handlers without the opt-out retain Coco's original behavior.

Routstrd's offline handler exports existing sat proofs without mint metadata,
keys or wallet-cache refreshes. This does not make explicit proof checks,
reclaim, or unrelated daemon activity offline. Re-evaluate this patch and the
private handler-registration integration on every Coco upgrade; prefer an
upstream local-handler API when available. The real-Manager test in
`offline-send.test.ts` uses stale metadata and a loopback mint returning 503,
asserts zero requests on local paths, and checks that online sends still fail
against the unavailable mint.

The Coco patch also guards `ProofStateWatcherService.watchProof()` across its
asynchronous trust check and subscription: when stopped, it must not subscribe
or retain a subscription that completes after `stop()`. A late subscription is
immediately unsubscribed. Stopped callbacks ignore late notifications, and
`stop()` drains notifications already writing proofs before returning. Both
distributed runtime builds and declarations are patched, with contextful hunks.
`online-proof-bootstrap.test.ts` exercises the real watcher shutdown races.

Routstrd replaces only Coco's **existing-inflight bootstrap**, not its event
listeners or online-send subscriptions. The replacement checks non-offline
proofs, emits normal spent-proof events, and subscribes survivors in a caught
background task. Offline proofs remain excluded; checks/subscriptions failing
for one mint do not abort the others or gate wallet startup. Do not call Coco's
`resumeSubscriptions()` without preserving this filtering: it recreates the
watcher with the original/default unfiltered bootstrap settings. Routstrd does
not currently call it.

Bootstrap wallet loading, mint checks and subscription waits each have a 30-second
budget so one stalled mint does not block later mints. A timeout is not transport
cancellation: the actual promises and bootstrap task remain registered as recovery
work, late check results are not applied, and shutdown retains the database/PID
claims until work settles. Shutdown callers get the existing 30-second incomplete-
disposal error rather than an unbounded wait; cleanup continues in the background.
The same resource-retaining rule applies when startup fails after bootstrap begins.
Coco's `Manager.dispose()` only disposes plugins, so routstrd explicitly pauses
subscriptions/stops watchers first, then drains tracked work, disposes plugins,
closes all subscription transports, and closes the database. The final
`subscriptions.closeAll()` is necessary because watcher/plugin unsubscribe sends
can reopen sockets even after `pauseSubscriptions()` closed them. Controlled
fake-WebSocket tests exercise the real transport on shutdown and startup failure. A permanently hung SDK request/plugin can therefore retain
resources until process exit; no timeout is represented as cancellation or a safe
opportunity to close a database that may still receive writes.

`resumeSubscriptions()` is not supported by the filtered bootstrap lifecycle: any
future caller must restart this bootstrap as well as keep offline filtering. Merely
forcing `watchExistingInflightOnStart: false` in the constructor would prevent the
unfiltered scan but silently omit the online bootstrap after resume.

## SDK request-funding cancellation

`@routstr/sdk` is pinned to 0.5.0 and patched across all distributed client/wallet
ESM and CommonJS builds and affected declarations. This is a backport of the
source fix in [SDK PR #137](https://github.com/Routstr/routstr-sdk/pull/137)
(commits `bbca1fb` and the follow-up settlement-sharing fix); remove/re-evaluate on SDK upgrade.
Declaration chunk filenames are preserved to avoid tsup hash-only churn.
Sourcemaps are not regenerated by this patch and still describe the original
package; use the upstream source diff when debugging these routines.

Request signals now reach spending, proactive/402 top-ups and wallet queues.
Cancellation gates new financial work after asynchronous preparation. Queued
batches exclude cancelled contributions; if one cancels during pre-send balance
or recovery waits, preparation recomputes for survivors. Per-client shared top-ups
stay live while any caller is live. Active financial work remains shareable through
settlement even when its last original caller cancels; individual aborts do not
replace the underlying settlement result. A live newcomer restarts cancelled
pre-send work only after that attempt drains. The automatic funding coordination described below separately addresses stale
balance deficits; manual additive batching retains its existing contract.

The daemon forwards the optional signal into `sendCashu`, checking it after wallet
recovery and immediately before Coco `send.prepare`. Once prepare starts, execute,
token persistence, top-up posting and financial recovery retain their existing
contracts: cancelling an HTTP request must not abandon already-moving funds.
Third-party wallet adapters with internal pre-send waits must honor the optional
signal at that boundary too. This is not remote-generation cancellation, does not
change disconnect wiring, and does not suppress legitimate usage accounting.

`src/daemon/wallet/sdk-funding-cancellation.test.ts` exercises the installed patched
runtime with in-memory wallets, gated preparation/queues and mocked inference and
deposit operations. `cancelled-funding.test.ts` covers adapter forwarding and a
real Coco client's recovery boundary without mint traffic. Neither test spends
funds or makes inference requests.


## SDK automatic funding / stale-deficit coordination

The SDK 0.5.0 patch also backports [SDK PR #138](https://github.com/Routstr/routstr-sdk/pull/138)
(`BalanceManager.ensureBalance`) and switches
proactive inference funding and local-insufficient-balance 402 funding to it.
Unlike manual `topUp({ amount })`, an automatic ensure expresses a balance target:
per wallet adapter, provider URL (trailing slash normalized), and API key, callers
wait for prior automatic financial settlement, then read fresh provider available
balance before deciding whether another deposit is justified. Each deposit applies
the existing path's shortfall/margin/minimum rules once, not once per stale caller.
`total_balance` is already net of reservations; reserved funds are never subtracted
again. Unknown/invalid/non-finite balances cannot authorize funding.

A stale request snapshot is only a trigger; it is no longer added to a deposit and
persisted as a synthetic fresh balance. Actual concurrent reservations may warrant
additional deposits after fresh reads. No universal "one deposit per burst" promise
is made. Manual amount-based top-ups remain additive and independent of automatic
ensures; SDK entrypoint bundles have module-local coordination (applications should
not mix separate bundled entrypoints for the same wallet). Multiple processes and
remote-provider eventual consistency are outside this in-process coordinator.

Cancellation is checked after queue/balance waits. Financial sends already started
still settle/persist/recover; a later live caller waits then reassesses rather than
replacing an active transaction. Queued automatic callers do not contribute additive
amounts that another caller's cancellation could accidentally erase.

`src/daemon/wallet/sdk-ensure-balance.test.ts` verifies the installed patched runtime
with in-memory state and gated sends/deposits: stale deficits across clients,
arrivals during settlement, new reservation shortfalls, wallet/provider/key
isolation, unknown balances, manual semantics, and cancellation. No real funds or
inference traffic are used. Runtime changes cover all 12 distributed client/wallet
ESM/CJS bundles; declaration filenames and original sourcemaps remain unchanged.
