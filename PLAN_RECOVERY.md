# Plan: mint-isolated, bounded wallet recovery

## Objective

A mint that is down, slow, locally throttled, or remotely rate-limiting must not block wallet operations at another mint. Recovery must retain its existing crash-safety guarantees: no duplicate receives, no competing recovery and live execution on the same operation, and no database closure beneath unfinished work.

This document is a proposal, not a claim that the changes are implemented. The independent probe deadline has been edited in the current checkout; the broader architecture below still needs implementation and validation.

## Observed failures

### 1. Unreachable mint delayed startup probing

In the previously inspected container (routstrd 0.4.12, Bun 1.2.22):

- Startup reported `Probing mints` at 14:10:20.679 UTC.
- Cuba's probe rejected at 14:12:35.190, approximately 135 seconds later.
- Recovery completed at 14:12:36.012.
- A new Minibits invoice operation was pending at 14:12:36.245.

The probe specified `AbortSignal.timeout(2000)` but awaited fetch directly. Cancellation did not cause that request to settle within the intended deadline. The logs establish the failed bound, but do not establish the exact Bun/network defect. Do not present a Bun upgrade as the proven solution.

The checkout fix races the read-only probe against an independent deadline, aborts the request as best-effort cleanup, and handles late rejection. It includes a regression test with a fetch implementation that ignores cancellation. This fixes the probe wait, not all recovery delays.

### 2. Reachable mints still caused a long global recovery delay

On this machine after a source-based daemon restart:

- Probing ran from 16:29:20.441 to 16:29:21.286 UTC: approximately 0.85 seconds.
- Send recovery ran until 16:31:39.499: approximately 138 seconds.
- Coco reported 60 pending sends checked.
- Cuba requests exhausted the local request-rate-limit bucket. Logs repeatedly reported `Queued request due to empty bucket`.
- The inspected limiter defaults refill at 20 requests/minute, approximately one token every three seconds. Watcher traffic also shares per-mint request capacity.
- Global recovery completed at 16:31:39.501.
- The user's Minibits Cashu receive finalized at 16:31:40.256.

This was not the original probe timeout. A sequential global recovery sweep and global gating delayed a healthy mint.

## Current architecture and limitations

Relevant code:

- `src/daemon/wallet/coco-client.ts`: startup recovery, recovery gate, wallet write methods, explicit recovery and disposal.
- `src/daemon/wallet/recovery-probe.ts`: operation enumeration, reachability probe, targeted recovery.
- `src/daemon/wallet/recovery-work.ts`: shared tracking, bounded waits and safe disposal.
- `src/daemon/wallet/recovery-integration.test.ts`: real Coco/SQLite safety tests.
- `src/daemon/wallet/recovery-probe.test.ts`: probe and targeted recovery tests.

PR #116's final implementation:

1. Collect stuck operations and probe their mints once.
2. If all probes answer, retain Coco's global recovery sweeps and global gate.
3. If a mint is unreachable, run local cleanup and recover the reachable operations through the targeted driver.
4. On the degraded path, permit callers for mints with no stuck operations after local cleanup.
5. Keep unfinished recovery work tracked and executing-send locks held until underlying work settles.

Additional limitations:

- Startup does not periodically repeat probing. Explicit targeted recovery can probe again.
- Any HTTP response, including 429 or 5xx, currently counts as reachable.
- Passing `/v1/info` does not guarantee that proof checks or swaps remain usable.
- A mint can deteriorate after the initial probe.
- Happy-path global sweeps do not inherit the targeted driver's operation/pass budgets.
- `receiveCashu()` currently uses the global recovery gate instead of a token-mint gate.
- `setDefaultMint()` also uses the global gate.
- Global `RECOVERING` status does not describe which mints are actually usable.

## Non-negotiable safety rules

1. Do not open gates earlier while continuing to run fresh global recovery enumeration underneath live operations.
2. Do local crash cleanup before admitting new wallet writes.
3. Retain shared family-and-operation-ID tracking across every recovery entry point.
4. A timeout ends a caller's wait, not necessarily the underlying work.
5. Do not release operation locks when the caller times out; release only when underlying execution settles.
6. Do not mark a deferred or merely attempted operation as recovered.
7. Preserve receive input-set deduplication, token reservations and deterministic persisted outputs.
8. Check state again under the relevant lock before driving an operation.
9. Respect shutdown: stop admission and scheduling, drain actual work, then close Coco/database and release ownership.
10. Fail closed if required Coco private APIs are unavailable.
11. Never retry a possibly submitted value-moving request by blindly creating a new operation.

## Proposed architecture

### A. Build a startup recovery coordinator

Use the targeted, snapshot-based recovery model on both healthy and degraded startups. Remove the dependency on fresh global sweeps for routine startup recovery, but only after proving that all their cleanup responsibilities are preserved.

Startup sequence:

1. Open wallet and establish exclusive ownership.
2. Run existing receive classification and reservation reconciliation.
3. Capture recovery candidates and identify all affected mints.
4. Run verified local-only crash cleanup.
5. Reconcile or re-read the candidate snapshot where cleanup changed state.
6. Publish initial per-mint recovery state.
7. Run independent mint recovery passes with bounded concurrency.
8. Reconcile reservations and publish each mint's result independently.
9. Publish aggregate recovery status after all passes finish or defer.

Mints without relevant recovery work may open after local cleanup. A mint with work waits only for its own pass and safety checks, not another mint's network traffic.

Keep a small concurrency limit across mints (initial proposal: two). Within a mint, start with sequential recovery rather than concurrent requests, to simplify lock ordering and avoid bursts. Tune only after measurements.

Do not add a second rate limiter that fights Coco's existing limiter. Budgets must account for existing queue delays.

### B. Preserve global-sweep housekeeping explicitly

Before replacing global sweeps, audit Coco's send, melt, receive and mint recovery code. Create a behavior matrix covering:

- Init-operation cleanup.
- Prepared operations that require explicit rollback rather than automatic recovery.
- Executing operations.
- Pending operations.
- Rolling-back operations and unsupported/manual-recovery states.
- Orphaned proof reservations.
- Receive reservation synchronization.
- Mint quote settlement and pending mint recovery.
- History updates and emitted events.

For each behavior, identify the equivalent supported API or narrowly encapsulated private adapter. Record intentionally manual states in status; do not silently omit them.

Verify private method availability before cleanup writes. Prefer an upstream mint-filtered recovery API where feasible, but do not assume one exists.

### C. Per-mint state and gates

Suggested state model:

- `initializing`: local safety work is not finished.
- `recovering`: the mint's pass is active.
- `ready`: its startup reconciliation finished and writes may proceed.
- `deferred`: some work remains because of connectivity, throttling, budget exhaustion or a busy operation.
- `error`: a safety-critical failure prevents admission.

Also track whether underlying recovery work remains active. `deferred` is not automatically permission to write.

Conservative first policy:

- Healthy ready mints admit writes independently.
- A deferred mint rejects new value-moving operations with a clear retryable reason rather than hanging indefinitely.
- If a mint has tracked unfinished work, keep its write admission closed unless a later, separately reviewed operation-level safety policy permits otherwise.
- Wallet reads remain available.

Suggested metadata per mint:

- Counts by operation family and state.
- Attempted, confirmed complete, busy, failed, timed-out and deferred counts.
- Start/end timestamps and pass deadline.
- Defer reason and retry eligibility time.
- Whether actual in-flight work still exists.

Normalize URLs consistently, preserving paths such as `/Bitcoin`. The mint identity and gate key must agree across configuration, persisted operations and decoded tokens.

### D. Gate each wallet operation using its actual mint

Audit every wallet method, not just the observed cases:

- Cashu send: resolve target mint before admission.
- Lightning send: resolve target mint before admission.
- Lightning invoice generation: resolve target mint before admission.
- Cashu receive: decode and validate the token's mint before gating; do not use the configured default.
- Explicit recovery/cleanup: use the coordinator and tracker instead of bypassing it.
- Multi-mint operations, if supported: require admission for every affected mint.

Cashu receives need special care because token reservation currently happens before waiting and existing unresolved reservations may refresh an operation. Audit both fresh and resumed receive branches. Ensure all value-moving refreshes follow recovery coordination and cannot bypass the gate or deduplication checks.

For default-mint changes:

- Switching to an already trusted mint should not depend on another mint's network recovery.
- Preserve local configuration and disposal synchronization.
- Adding or trusting a new mint requires its own bounded validation.
- Changing a default must never make the mint appear ready or bypass unfinished recovery.

### E. Bound every mint pass

Initial proposed defaults, subject to tests and deployment measurements:

- Read-only reachability probe: 2 seconds.
- Individual recovery observation/drive wait: 15 seconds.
- Total mint pass observation budget: 60 seconds.
- Maximum concurrently recovering mints: 2.

These are coordinator wait limits, not promises that underlying requests are canceled. The total budget includes time waiting for locks or Coco's local rate limiter, not just HTTP service time.

Once a mint's budget is exhausted:

1. Stop scheduling its remaining operations.
2. Record untouched operations as deferred.
3. Keep any actual unfinished work tracked.
4. Preserve locks until that work settles.
5. Allow other ready mints to proceed.
6. Report how and when the deferred mint can be retried.

Pass budgets must apply across operation families, not reset independently for send, melt, receive and mint. Otherwise the advertised total bound can multiply.

### F. Detect deterioration during recovery

Treat the probe as an initial hint, not durable proof of health. Repeated `/v1/info` calls are not a substitute for observing recovery outcomes.

Suggested classification:

| Signal | Interpretation | Proposed action |
| --- | --- | --- |
| Successful recovery response | Relevant endpoint usable | Continue within budget |
| Local limiter queue delay | Local pacing, not evidence of outage | Respect pacing; defer on pass budget exhaustion |
| HTTP 429 | Remote throttling | Stop scheduling this mint; respect bounded `Retry-After` |
| HTTP 5xx | Remote service failure | Defer after a small configurable failure threshold |
| Connect/network timeout | Endpoint not usable within budget | Defer after a small configurable failure threshold |
| Operation-specific terminal error | Not necessarily a mint outage | Record operation result; continue where safe |
| Held operation lock | Live or unfinished work owns it | Mark busy; never compete |
| Ambiguous/suppressed error | Insufficient evidence | Record uncertainty; rely on pass deadline, not invented completion |

Inspect the actual errors exposed by Coco/cashu-ts before designing status-code checks. Some recovery wrappers swallow errors or return unresolved state; these cannot be counted as successful recovery merely because their promise resolved.

If structured 429/status/headers are lost, add a narrow adapter or upstream hook at the transport boundary. Do not parse log messages as production control flow. Never log token contents or proof secrets.

`Retry-After` handling must support seconds and HTTP dates, clamp unreasonable values, and remain advisory across restarts unless persisted deliberately.

### G. Retry deferred work safely

First release: explicit operator-triggered recovery, plus recovery on next startup. Do not immediately restore the previously removed periodic retry loop.

Explicit retry must:

- Select deferred work deliberately.
- Probe/classify current health with bounded waits.
- Reuse existing operation IDs and persisted outputs.
- Skip locked operations and unfinished tracked work.
- Reapply safe receive classification before retrying receives.
- Avoid overlapping passes for the same mint.
- Respect shutdown and admission state.

Later automatic retries require a separate review of backoff, jitter, watcher overlap, receive deduplication, retry persistence and shutdown behavior. A pass may be eligible for retry without being safe to retry yet.

### H. Status and CLI behavior

Preserve compatibility where possible while exposing mint-level detail:

- Global summary can say recovering/degraded/ready, but must not imply every mint is unavailable.
- Show each mint's state, remaining work, reason and retry eligibility.
- Clarify whether the requested command is waiting for its target mint.
- Deferred target-mint commands should fail promptly with a retryable diagnostic.
- Avoid a generic warning that all send/receive operations resume only after global recovery.

Use transition-based logs rather than a line per queued request or each repeatedly skipped operation. Include elapsed time and counts at the end of each mint pass.

## Implementation phases

### Phase 1: characterize safety and APIs

- Audit all global recovery housekeeping and targeted recovery equivalence.
- Inspect lock behavior of public refresh/finalize APIs for all families.
- Inspect error propagation, local limiter queueing and cancellation.
- Map every write method to its required mint and recovery coordination.
- Add characterization tests before changing gating.

Deliverable: documented behavior matrix and tests that establish what must be preserved.

### Phase 2: coordinator and per-mint admission

- Introduce a shared coordinator/state model.
- Replace routine global startup network sweeps with snapshot-based mint passes.
- Preserve local cleanup before admission.
- Open ready mint gates independently.
- Implement Cashu token-mint admission and audit resumed receives.
- Keep conservative admission for deferred/in-flight mints.

Deliverable: unrelated healthy mint can operate while another mint is still recovering, without unsafe global enumeration.

### Phase 3: deadlines and adaptive deferral

- Apply per-operation and total per-mint budgets.
- Retain actual in-flight tracking and locks.
- Add structured throttling/network classification.
- Stop remaining work for unhealthy mints and expose retry metadata.

Deliverable: passing the startup probe cannot lead to an unbounded global wallet stall later.

### Phase 4: diagnostics and operator retry

- Expose mint-level status in HTTP and CLI.
- Make command warnings target-aware.
- Route explicit retries through the same coordinator.
- Ensure shutdown/disposal tests cover timed-out and queued work.

Deliverable: operators can understand and safely retry deferred recovery without restarting unnecessarily.

## Test plan

Use disposable SQLite wallets and a controllable local fake mint. Do not redeem real user tokens in tests.

### Probe tests

- Fetch ignores abort forever: coordinator returns within its independent deadline.
- Fetch rejects after the deadline: no unhandled rejection.
- HTTP 429 and 5xx get the intended health classification.
- Subpath mint URLs remain correct.
- Malformed persisted mint URL does not block unrelated mints.

### Recovery isolation tests

- One dead mint and one healthy funded mint.
- All mints initially healthy, but one has many pending sends.
- One mint passes probing, then returns 429 after 20/50 calls.
- One mint passes probing, then hangs or blocks connections.
- Local rate-limit capacity exhausts while watcher traffic continues.
- Healthy mint Cashu receive, Lightning invoice, Cashu send and Lightning send proceed independently.
- A healthy mint with its own stuck operations waits only for its own safe reconciliation.
- Switching to an already trusted default does not wait for unrelated network recovery.

### Safety tests

- Global housekeeping equivalence for each family/state.
- Recovery cannot drive an operation held by live execute.
- Re-read under lock prevents stale snapshot execution.
- Timeout retains actual work and executing-send lock.
- Explicit retry skips work still running beneath an earlier timeout.
- Fresh and resumed receives preserve token/input-set deduplication.
- Unresolved receive groups remain untouched until safely classified.
- Late recovery completion updates state without falsely admitting unsafe writes.
- Missing private Coco internals fail before cleanup writes.
- Family-qualified IDs avoid cross-family tracker collisions.
- Aggregate pass budget includes all families and local queue time.

### Shutdown tests

- Stop scheduling immediately on disposal.
- Do not close SQLite while tracked work remains.
- Retain ownership until actual cleanup finishes.
- Caller timeout reports incomplete shutdown rather than falsely reporting closure.
- Late failures remain handled.

### Validation commands

Run focused wallet recovery tests, TypeScript checking, the full test suite where practical, and a build. Repeat fake-mint scenarios on the deployed Bun version and the development Bun version. Timing tests should use short injected budgets and generous watchdog tolerances rather than fragile exact millisecond assertions.

## Acceptance criteria

1. An unavailable Cuba mint cannot prevent a ready Minibits mint from receiving or spending after local startup cleanup.
2. A mint becoming rate-limited or unreachable after probing cannot stall other mint gates.
3. Every scheduled recovery wait and mint pass has an enforced coordinator deadline.
4. Deferred operations remain persisted and can be safely retried; no false recovered count.
5. No timed-out work loses its lock/tracker early.
6. Existing cleanup, receive deduplication and shutdown safety remain covered by regression tests.
7. Operators can distinguish local pacing, remote throttling, unreachable mint and unresolved operation.
8. No production wallet restart, migration or token redemption is required to validate the implementation.

## Deployment and rollback

- Do not change persisted operation formats unless necessary. Prefer an in-memory coordinator initially.
- Validate on a disposable copy before production rollout; ensure ownership rules prevent simultaneous access to the same wallet.
- Do not tune away rate limiting merely to make tests fast.
- Preserve the independent probe-deadline fix even if the broader coordinator rollout is delayed.
- Review version compatibility for private Coco adapters at build/test time and fail closed at runtime.
- Rollback must preserve pending operation rows and reservations. Never delete deferred work to make status appear ready.

## Open decisions

- Whether an upstream mint-filtered recovery API can replace private adapters.
- How to safely represent outcomes for public recovery methods that swallow errors.
- Exact default budgets and whether configuration should be exposed immediately.
- Whether a deferred mint with no actual unfinished work may admit selected operations; initially keep this conservative.
- How much retry eligibility metadata should survive restart.
- Whether global status needs a new public enum or additive fields for compatibility.
- Whether local limiter diagnostics can be exposed without changing upstream dependencies.

These decisions should be resolved from characterization tests and actual API behavior, not by weakening recovery gates to reduce visible waiting.
