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
subscriptions/stops watchers first, then drains tracked work, disposes plugins and
closes the database. A permanently hung SDK request/plugin can therefore retain
resources until process exit; no timeout is represented as cancellation or a safe
opportunity to close a database that may still receive writes.

`resumeSubscriptions()` is not supported by the filtered bootstrap lifecycle: any
future caller must restart this bootstrap as well as keep offline filtering. Merely
forcing `watchExistingInflightOnStart: false` in the constructor would prevent the
unfiltered scan but silently omit the online bootstrap after resume.
