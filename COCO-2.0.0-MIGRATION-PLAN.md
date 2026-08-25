# Coco 2.0.0 migration plan

## Objectives

The migration must accomplish four things safely:

1. Upgrade Routstrd from Coco `1.0.1` to `2.0.0`.
2. Prevent old receive operations from causing a multi-hour first startup.
3. Prevent repeated submission of the same Cashu proofs from creating duplicate receive operations.
4. Preserve a reliable rollback path for legacy cocod wallets and existing Routstrd wallets.

The migration should **not** rely solely on Coco 2.0's normal receive recovery. Coco 2.0 correctly rolls back spent inputs whose restore returns no outputs, but it still processes receive rows individually. A wallet with 1,924 duplicate rows could therefore still experience one final long recovery before the rows become terminal.

---

# 1. Target dependency set

Upgrade these as a coordinated set:

```text
@cashu/coco-core        1.0.1 → 2.0.0
@cashu/coco-sqlite-bun  1.0.1 → 2.0.0
@cashu/cashu-ts                 → 5.0.0-rc.4-compatible version
```

Do not upgrade only `@cashu/coco-core`. The SQLite adapter has an exact peer relationship with Coco 2.0.0 and Cashu TS 5.0.0-rc.4.

## NPC compatibility gate

The existing NPC integration is the largest dependency risk:

```text
coco-cashu-plugin-npc@2.4.1
└─ peer: coco-cashu-core ^1.1.2-rc.50
```

Routstrd currently bridges the old and new Coco package families using a structural cast. Before the migration can ship, verify that the plugin still works with Coco 2.0's:

- plugin registration contract,
- service map,
- mint service,
- mint operation service,
- quote APIs,
- manager lifecycle,
- shutdown lifecycle.

If it is not compatible, choose one of these before release:

1. Upgrade to a Coco 2-compatible NPC plugin.
2. Patch/fork the plugin temporarily.
3. Put NPC behind a compatibility feature flag and refuse the migration for NPC-enabled wallets.
4. Disable NPC only with explicit user notice—not silently.

---

# 2. Required startup architecture

The startup order is critical.

Today, constructing `SqliteRepositories` and calling `repo.init()` applies adapter migrations. The new receive preflight must therefore happen **before** Coco 2.0's repository initialization.

The intended startup pipeline should be:

```text
Acquire wallet and legacy cocod locks
│
├─ Locate wallet source
│  ├─ fresh wallet
│  ├─ legacy cocod wallet
│  ├─ current Routstrd Coco 1 wallet
│  └─ already-migrated Coco 2 wallet
│
├─ Create committed SQLite snapshot
│
├─ Validate snapshot and write pre-upgrade manifest
│
├─ Run legacy receive-operation preflight
│  ├─ inspect receive operations
│  ├─ fingerprint proof sets
│  ├─ collapse provable duplicates
│  └─ reconcile ambiguous groups with bounded mint requests
│
├─ Verify preflight invariants
│
├─ Open staged DB using Coco 2 adapter
│  └─ repo.init() applies Coco 2 schema migrations
│
├─ Verify post-schema-migration invariants
│
├─ Initialize complete Coco 2 Manager lifecycle
│
├─ Run bounded recovery over remaining unique operations
│
├─ Verify wallet balances/proofs
│
├─ Commit staged wallet atomically
│
└─ Start value-moving services
```

The source database must remain unchanged until every staging check succeeds.

---

# 3. Wallet version detection

Add an explicit wallet-format detector that works using raw SQLite, without importing or initializing a Coco repository.

It should identify:

```text
fresh
legacy-cocod
coco-v1
coco-v2
unknown-or-partially-migrated
```

Detection should use:

- presence of `config.json`,
- presence of `coco.db`,
- SQLite migration table contents,
- table and column signatures,
- WAL/SHM presence,
- a Routstrd-owned migration marker,
- Coco adapter migration IDs.

Do not infer wallet format only from the installed application version.

## Refusal states

Startup must stop without modifying the wallet if:

- `coco.db` exists without its matching `config.json`,
- source and destination wallets both exist and differ,
- the SQLite database fails `PRAGMA quick_check`,
- the schema is unknown,
- a previous migration is partially committed,
- required sidecar files cannot be included in the snapshot,
- another wallet process holds the database,
- there is insufficient disk space for source + backup + staging database.

---

# 4. Snapshot and rollback strategy

## Always migrate a snapshot

For both legacy cocod and existing Routstrd wallets:

1. Stop or fence all wallet engines.
2. Acquire the wallet lock.
3. Open the source database using raw SQLite.
4. Run `PRAGMA quick_check`.
5. Create a standalone committed snapshot using `VACUUM INTO`.
6. Verify the snapshot independently.
7. Perform preflight and Coco 2 migration only on the snapshot.

This includes committed WAL frames and avoids copying an incomplete main database file.

## Pre-upgrade manifest

Before changing the staged snapshot, record a privacy-safe manifest containing:

- migration ID,
- source format,
- source database hash,
- SQLite migration IDs,
- proof counts by mint/unit/state,
- proof amounts by mint/unit/state,
- counter values by mint/keyset/unit,
- receive counts by state,
- receive unique-proof-set counts,
- send/melt/mint operation counts by state,
- trusted mints,
- history row count,
- database file size,
- backup path,
- timestamp.

Do not record:

- proof secrets,
- encoded tokens,
- output blinding data,
- mnemonic material.

## Backup retention

Keep:

```text
wallet-backups/
└─ pre-coco-2-<timestamp>/
   ├─ config.json
   ├─ coco.db
   ├─ manifest.json
   └─ README-restore.txt
```

A Coco 2 database must not be opened by Coco 1 after migration. Downgrade means restoring the entire pre-upgrade snapshot, not reinstalling the old binary over the new database.

---

# 5. Legacy receive-operation preflight checker

## Purpose

The preflight checker must ensure users do not encounter hours of network recovery on their first Coco 2 startup.

It runs:

- after a committed snapshot has been created,
- against the staged Coco 1-format database,
- before `SqliteRepositories.init()` applies Coco 2 schema migrations.

It should be idempotent and safe to rerun after a crash.

## Preflight modes

Provide two modes:

```text
inspect
reconcile
```

### Inspect mode

Read-only. It reports:

- executing receive rows,
- unique input-proof sets,
- duplicate count,
- counts by mint,
- locally finalized siblings,
- groups with locally persisted output proofs,
- groups requiring mint reconciliation,
- estimated worst-case mint calls,
- estimated recovery duration.

### Reconcile mode

Mutates only the staged snapshot and creates a complete audit record of every state transition.

Production migration uses `reconcile`; a diagnostic CLI command should expose `inspect`.

---

# 6. Receive fingerprint design

Every receive operation must get a canonical, privacy-safe fingerprint representing the actual input proof set.

Conceptually:

```text
fingerprint = SHA-256(
  version
  + normalized mint URL
  + unit
  + sorted proof identifiers
)
```

The proof identifier should be Cashu's public `Y` derived from each proof secret, not the raw secret.

Requirements:

- normalize mint URLs consistently with Coco,
- include the Cashu unit,
- sort proof identifiers so proof order does not matter,
- include proof count,
- use domain separation/versioning,
- never log raw proof secrets,
- never use only the encoded token string.

Equivalent tokens containing the same proofs in different orders must produce the same fingerprint.

A fingerprint identifies a proof set, not a receive operation's deterministic outputs. Multiple duplicate operations can share one fingerprint while having different `outputData`.

---

# 7. Preflight classification algorithm

Group every legacy receive operation by fingerprint.

For each group, inspect:

- operation states,
- operation timestamps,
- `outputData`,
- local proofs linked by `createdByOperationId`,
- local proof secrets matching deterministic outputs,
- local history,
- local input-proof states,
- input/output operation linkage.

## Class A: finalized operation or outputs already saved locally

If one operation has locally persisted outputs:

- preserve/finalize that operation,
- mark duplicate nonterminal operations `rolled_back`,
- do not contact the mint.

Reason:

```text
The wallet already has the receive outputs.
Other operations using the same inputs cannot represent additional value.
```

If multiple operations appear finalized for the same fingerprint, flag the wallet for deeper invariant checking. This may be legitimate history duplication, but amounts must not be counted twice.

## Class B: all inputs locally known spent by a finalized local operation

If input proofs are linked to a known successful local operation and no candidate has missing outputs:

- roll back duplicate executing rows locally,
- do not contact the mint.

The audit reason should distinguish this from an empty restore:

```text
Preflight: duplicate receive inputs already consumed by finalized local operation
```

## Class C: duplicate group with inputs confirmed UNSPENT at the mint

Make one proof-state request for the fingerprint, not one per operation.

If every input is `UNSPENT`:

- retain one canonical operation for retry,
- mark duplicate operations `rolled_back`,
- let Coco 2 re-execute only the canonical operation.

Canonical selection should be deterministic:

1. operation with the most complete valid prepared data,
2. oldest operation if completeness is equal,
3. stable operation-ID tie-breaker.

The retained operation must have valid `outputData`. If none does, preserve the group for manual recovery rather than guessing.

## Class D: inputs confirmed SPENT at the mint

This is the important stuck-wallet case.

Because duplicate operations have different deterministic outputs, a successful swap may correspond to any one candidate's `outputData`. It is unsafe to select an arbitrary operation before checking restore results.

The checker should:

1. Generate all expected blinded outputs for the group from stored `outputData`.
2. Submit them to `/v1/restore` in bounded batches.
3. Map returned output signatures back to the owning operation.
4. Classify candidates:

```text
matching restored outputs
├─ preserve matching operation for Coco 2 finalization
└─ roll back nonmatching duplicates

no matching restored outputs
└─ roll back all operations in the group

partial/inconsistent restored outputs
└─ stop automatic migration and require recovery review
```

A successful empty restore response is authoritative for the supplied output set and should result in:

```text
rolled_back
error = "Preflight: input proofs spent without recoverable outputs"
```

The checker does not need to save/unblind restored proofs itself if that would duplicate Coco internals. It can preserve the matching operation as the sole `executing` row and allow Coco 2 to recover it normally.

## Class E: mixed proof states

If inputs are a mixture of:

- `SPENT`,
- `UNSPENT`,
- `PENDING`,
- unknown states,

do not automatically roll back the group.

Attempt bounded restore matching. If no conclusive outcome exists:

- preserve the minimum necessary candidate set,
- flag the group as unresolved,
- expose it clearly in migration status,
- do not silently launch an unbounded recovery sweep.

## Class F: mint unavailable or timeout

An unavailable mint is not evidence that funds are unrecoverable.

The checker must:

- retain the canonical unresolved operation,
- avoid retaining hundreds of obvious duplicates where safety can be established locally,
- stop retrying when the migration network budget is exhausted,
- report the wallet as "migration pending mint availability."

Policy options should be configurable:

```text
fail closed       default; migration pauses and explains why
defer recovery    daemon starts read-only, value-moving operations remain blocked
operator override explicit CLI action only
```

Never automatically roll back an unresolved unique proof set only because the mint is offline.

---

# 8. Bounded and deduplicated mint requests

The preflight must not merely replace a two-hour Coco sweep with another two-hour custom sweep.

## Request strategy

- Check proof states once per unique fingerprint.
- Group requests by normalized mint URL.
- Batch proof-state checks according to protocol/mint limits.
- Batch restore outputs across duplicate candidates where supported.
- Map responses by `Y` or blinded output identifier.
- Apply per-mint rate limits.
- Apply request timeouts.
- Use bounded retries with exponential backoff.
- Persist progress after each completed batch.
- Resume from the last completed batch after restart.

## Migration budget

Define explicit limits, for example:

```text
per-request timeout
per-mint wall-clock budget
global preflight wall-clock budget
maximum retry count
maximum outputs per restore batch
```

Do not hard-code the exact values until tested against common mints.

If the budget is exhausted:

- stop network reconciliation,
- save the checkpoint,
- keep the original wallet untouched,
- show exact unresolved counts,
- allow the user to resume later.

## Expected effect on the observed wallet

Instead of processing 1,924 rows independently:

```text
1,924 receive rows
└─ 47 unique input sets
```

Proof-state work becomes approximately one check per unique set, and restore work becomes batched by mint/output count. Even without aggressive batching, the cost should be based on 47 groups rather than 1,924 rows.

---

# 9. Safe preflight database transitions

All preflight mutations must happen in explicit SQLite transactions.

For each batch:

```text
BEGIN IMMEDIATE

├─ verify candidate rows still have expected state/data
├─ insert audit records
├─ mark duplicates/terminal rows rolled_back
├─ update timestamps using Unix seconds
├─ write preflight checkpoint
└─ COMMIT
```

Coco SQLite stores these timestamps in Unix seconds, so direct SQL updates must use:

```sql
updatedAt = unixepoch()
```

Do not write millisecond timestamps directly.

## Audit data

Use a Routstrd-owned migration audit table or sidecar manifest containing:

- operation ID,
- fingerprint,
- original state,
- resulting state,
- reason code,
- evidence category,
- mint URL hash or normalized URL,
- reconciliation timestamp,
- restore/check batch ID.

Reason codes should be machine-readable, for example:

```text
duplicate_of_local_finalized
duplicate_unspent_canonical_retained
spent_no_recoverable_outputs
recoverable_outputs_owned_by_sibling
mixed_state_unresolved
mint_unreachable
invalid_legacy_operation
```

No secrets or full token material should be stored in the audit log.

---

# 10. Post-preflight invariants

Before allowing Coco 2 schema migration:

1. `PRAGMA quick_check` returns `ok`.
2. Proof rows are unchanged unless the preflight explicitly recovered proofs.
3. Proof totals by mint/unit/state are unchanged.
4. Counters never decrease.
5. Trusted mint records are unchanged.
6. Every rolled-back receive has an audit record.
7. At most one unresolved operation remains per fingerprint unless explicitly classified ambiguous.
8. No finalized operation was demoted.
9. No operation with locally persisted outputs was discarded.
10. Remaining executing receive count is small and explained.
11. The original source snapshot remains unchanged.

If any invariant fails, discard the staging database and retain the source wallet.

---

# 11. Coco 2 schema migration

After receive preflight succeeds:

1. Open the staged database.
2. Construct the Coco 2 `SqliteRepositories`.
3. Call `repo.init()` exactly once.
4. Allow the official adapter to perform schema migrations.
5. Do not manually reproduce Coco's general schema migration SQL.
6. Close and reopen the migrated database.
7. Verify the new schema and migration IDs.

## Post-schema verification

Compare the post-migration database against the pre-upgrade manifest:

- proof counts and amounts,
- proof states,
- counters,
- receive states,
- send/melt/mint operation states,
- trusted mints,
- history row count,
- units,
- operation IDs.

Account for legitimate Coco 2 transformations such as amount representation and added columns, but the economic totals must remain equal.

Any amount conversion discrepancy is a release blocker.

---

# 12. Coco 2 Manager lifecycle migration

Routstrd manually initializes Coco to avoid blocking HTTP startup on recovery. That initialization must be reviewed against Coco 2.

Coco 2 introduces or changes lifecycle pieces including:

- payment-request receive recovery,
- melt quote watcher,
- melt settlement processor,
- canonical quote handling,
- updated mint operation behavior,
- updated plugin surface,
- disposal semantics.

Create one Routstrd initialization function that mirrors Coco 2's official `initializeCoco()` sequence except where recovery is intentionally deferred.

Document every difference from upstream.

Conceptually:

```text
construct Manager
├─ initialize plugins
├─ reconcile legacy/canonical quote state
├─ enable required watchers
├─ enable required processors
├─ register NPC only after compatibility validation
├─ expose read-only status
└─ start controlled recovery
```

Do not accidentally omit new Coco 2 watchers/processors just because the old custom bootstrap did not know about them.

---

# 13. Remaining recovery after migration

After preflight, Coco 2 recovery should see:

- no obvious duplicate receive rows,
- no known spent-and-unrestorable rows,
- at most one canonical operation per unresolved proof set,
- any operation with recoverable outputs preserved.

Run recovery in this order:

```text
receive preflight verification
send recovery
melt recovery
receive recovery
payment-request receive recovery
mint recovery
```

The final order should track Coco 2's documented requirements.

## Recovery gating

Continue allowing safe reads during recovery, but block all value-moving actions:

- receive,
- send,
- melt,
- mint,
- mint trust changes,
- NPC actions that can move funds.

Expose recovery state through health/status:

```json
{
  "state": "MIGRATING",
  "phase": "receive-preflight",
  "legacyReceiveRows": 1924,
  "uniqueReceiveSets": 47,
  "groupsResolved": 42,
  "groupsRemaining": 5,
  "networkRequests": 61,
  "elapsedMs": 42000
}
```

The generic `/health` endpoint should distinguish "HTTP process alive" from "wallet ready for value movement."

---

# 14. Preventing future duplicate receive operations

Coco 2 fixes terminal recovery, but ordinary `wallet.receive(token)` still does not appear to provide a general proof-set uniqueness guarantee. Routstrd needs its own receive coordinator.

## Persistent receive guard

Create a Routstrd-owned receive guard keyed by the canonical fingerprint.

Suggested fields:

```text
fingerprint              PRIMARY KEY
mintUrl
unit
proofCount
operationId
state
terminalReason
attemptGeneration
createdAt
updatedAt
```

Possible states:

```text
reserved
executing
finalized
rolled_back_retryable
rolled_back_terminal
unknown
```

## Receive flow

Replace the direct call:

```text
coco.wallet.receive(token)
```

with:

```text
decode and validate token
└─ compute fingerprint
   └─ acquire per-fingerprint mutex
      ├─ reconcile guard with Coco operation records
      ├─ inspect existing guard state
      ├─ reserve fingerprint persistently
      ├─ create/execute one Coco receive operation
      ├─ persist resulting operation ID/state
      └─ release mutex
```

## Duplicate behavior

### Existing finalized receive

Return an idempotent terminal result:

```json
{
  "success": true,
  "deduplicated": true,
  "credited": false,
  "status": "already_received"
}
```

This lets refund systems remove the token without implying that the wallet was credited twice.

### Existing executing receive

Do not create another operation.

Return:

```json
{
  "success": false,
  "retryable": true,
  "status": "receive_in_progress",
  "operationId": "..."
}
```

Optionally trigger one controlled refresh of the existing operation.

### Existing terminal rolled-back receive

Return a terminal result such as:

```json
{
  "success": false,
  "retryable": false,
  "status": "already_spent_or_unrecoverable"
}
```

The caller should stop retrying the token.

### Retryable rolled-back receive

Allow a new generation only after confirming the inputs remain unspent or the prior reason was explicitly transient.

Do not treat every `rolled_back` operation as retryable.

---

# 15. Crash consistency of the receive guard

A process can crash between:

```text
guard reservation
Coco operation creation
Coco operation completion
guard update
```

Therefore startup must reconcile the guard table with Coco receive operations.

Cases:

```text
guard reserved, no Coco operation
└─ clear or retry after stale-age validation

guard reserved, matching Coco operation exists
└─ attach operation ID and derive state

Coco operation exists, no guard row
└─ backfill guard from fingerprint

guard finalized, Coco executing
└─ verify local outputs before correcting either side

guard executing, Coco rolled_back
└─ copy terminal/retryable classification

multiple Coco operations for one fingerprint
└─ invoke duplicate reconciliation
```

The process-level wallet lock prevents multiple Routstrd daemons from receiving concurrently, while the fingerprint mutex prevents concurrent submissions inside one process. The persistent unique key protects against race conditions that escape in-memory locking.

---

# 16. SDK retry behavior

Deduplication in Routstrd prevents database growth, but the upstream caller should also stop repeatedly sending terminal tokens.

Update the wallet adapter contract to return structured outcomes:

```ts
type ReceiveResult =
  | { status: "received"; amount: number; unit: Unit }
  | { status: "already_received"; amount: number; unit: Unit }
  | { status: "in_progress"; retryAfterMs?: number }
  | { status: "mint_unreachable"; retryAfterMs?: number }
  | { status: "already_spent"; terminal: true }
  | { status: "invalid_token"; terminal: true }
  | { status: "unsupported"; terminal: true }
  | { status: "unknown"; retryable: boolean };
```

Avoid classifying behavior by matching strings in error messages.

## Cached refund policy

- `received`: remove cached refund token.
- `already_received`: remove cached refund token.
- `already_spent`: remove or quarantine it; do not retry.
- `invalid_token`: quarantine; do not retry.
- `in_progress`: keep but do not create another receive.
- `mint_unreachable`: retry with exponential backoff.
- `unknown`: bounded retry, then require operator review.

Every retry record should include:

- fingerprint,
- first attempt time,
- last attempt time,
- next attempt time,
- attempt count,
- last structured status.

Set an upper retry age and attempt count. A token must not be retried forever.

---

# 17. Legacy migration paths

## Fresh wallet

```text
No database
└─ initialize directly with Coco 2
   └─ create empty receive guard
```

No preflight is needed.

## Legacy cocod wallet

```text
legacy ~/.cocod
├─ stop and fence cocod
├─ snapshot into staging
├─ run receive preflight on staged legacy DB
├─ apply Coco 2 migration
├─ verify
├─ install canonical Routstrd wallet
└─ archive untouched legacy source
```

The existing legacy archive behavior should be retained.

## Existing Routstrd Coco 1 wallet

```text
canonical wallet exists
├─ acquire wallet lock
├─ snapshot to upgrade staging
├─ run preflight
├─ apply Coco 2 migration
├─ verify
└─ atomically replace active database
```

## Existing Coco 2 wallet without Routstrd receive guard

```text
detect Coco 2 schema
├─ do not rerun Coco schema migration
├─ scan historical receive operations
├─ backfill guard fingerprints
├─ reconcile duplicates
└─ mark Routstrd migration complete
```

## Already migrated wallet

Check the Routstrd migration marker and proceed normally. The operation must be idempotent.

---

# 18. Atomic commit strategy

Do not overwrite the active database in place while testing the migration.

Recommended commit sequence:

1. Stop all wallet access.
2. Close the staged Coco Manager and SQLite connection.
3. Run final integrity and manifest checks.
4. Rename active database to a rollback name.
5. Rename staged database to `coco.db`.
6. Fsync the containing directory where supported.
7. Start Coco 2.
8. Perform a read-only smoke check.
9. Mark migration committed.
10. Keep the rollback copy until a configured retention period passes.

If startup fails after the rename but before commit:

- stop Coco 2,
- preserve the failed staged database for diagnosis,
- restore the original database,
- restore the old application version only as part of the documented rollback procedure.

---

# 19. User and operator experience

## Automatic migration output

Example:

```text
Preparing Cashu wallet upgrade to Coco 2.0...
Created rollback snapshot.
Checking 1,924 unfinished receive operations...
Found 47 unique input proof sets and 1,877 duplicates.
Resolved 44 sets locally.
Checking 3 unresolved sets with their mints...
Receive preflight complete:
  1 recoverable operation retained
  1,923 stale operations retired
Applying Coco 2.0 database migration...
Verifying proofs, counters, balances, and operations...
Wallet upgrade complete.
```

## Unavailable mint

Example:

```text
Wallet upgrade paused safely.

2 unique receive operations at https://mint.example could not be verified.
No wallet data was replaced and no operations were discarded.

Run:
  routstrd wallet migration status
  routstrd wallet migration resume
```

Do not present an apparently healthy wallet while all value-moving calls are silently waiting on migration.

## Suggested CLI

```text
routstrd wallet migration inspect
routstrd wallet migration start
routstrd wallet migration status
routstrd wallet migration resume
routstrd wallet migration rollback
```

Potential expert-only command:

```text
routstrd wallet migration export-report
```

The report must remain privacy-safe.

---

# 20. Testing plan

## A. Coco 2 compatibility tests

- Manager construction.
- Plugin initialization.
- NPC address retrieval.
- NPC username setup.
- NPC synchronization.
- Mint addition and default mint persistence.
- Mint quote creation and recovery.
- Send, melt, and receive operations.
- Watcher startup and shutdown.
- Manager disposal.
- Background recovery gating.

## B. Schema migration fixtures

Maintain frozen fixtures for:

- cocod `0.0.24`,
- current Routstrd/Coco `1.0.1`,
- Coco 1 wallet with WAL frames,
- Coco 1 wallet without receive table,
- Coco 1 wallet with all receive states,
- Coco 2 wallet,
- interrupted/partially migrated database.

For every fixture, compare pre/post economic manifests.

## C. Stuck receive fixture

Create a sanitized fixture shaped like production:

```text
1,924 executing rows
47 unique input sets
multiple mints
large duplicate groups
some finalized siblings
some empty restores
some recoverable outputs
some unavailable mints
```

Assertions:

- network work scales with 47 groups, not 1,924 rows,
- no startup requires hours,
- empty restores become rolled back,
- recoverable output owners are preserved,
- duplicate rows are retired,
- second startup performs no receive recovery for terminal groups.

## D. Deduplication tests

1. Submit identical token twice sequentially.
2. Submit identical token concurrently.
3. Submit equivalent token with reordered proofs.
4. Submit equivalent token with different encoding.
5. Restart between guard reservation and Coco operation creation.
6. Restart between operation creation and guard update.
7. Submit a token already finalized before guard-table introduction.
8. Submit a terminally spent token repeatedly.
9. Submit a token while its first receive is still executing.
10. Confirm only one active Coco receive operation exists per fingerprint.

## E. Preflight safety tests

- Locally finalized sibling.
- Inputs all unspent.
- Inputs all spent, empty restore.
- Inputs all spent, one candidate restore match.
- Inputs all spent, multiple inconsistent matches.
- Mixed proof states.
- Mint timeout.
- Malformed output data.
- Missing operation output data.
- Database write failure mid-batch.
- Crash after audit insertion but before operation update.
- Resume after checkpoint.
- Timestamp units remain Unix seconds.

## F. Rollback tests

- Failure before preflight mutation.
- Failure during preflight transaction.
- Failure during Coco schema migration.
- Failure during post-migration verification.
- Failure after atomic rename.
- Restore pre-upgrade snapshot and run old binary.
- Ensure the old binary never opens the Coco 2 database.

---

# 21. Release strategy

## Stage 1: Compatibility branch

- Upgrade dependencies.
- Adapt Manager lifecycle.
- Resolve NPC compatibility.
- Run existing tests.
- No production migration yet.

## Stage 2: Offline migration tool

- Implement scanner, manifest, preflight and staging.
- Test against copied production databases.
- Do not integrate automatic startup migration yet.

## Stage 3: Receive coordinator

- Add fingerprint guard.
- Add structured receive results.
- Update SDK retry handling.
- Verify no new duplicates can be created.

This should land before automatic Coco 2 migration so migrated users are protected immediately.

## Stage 4: Canary

Use copied production wallets first, then a small opt-in user cohort.

Canary gates:

- exact proof totals preserved,
- exact spendable balances preserved,
- recovery duration within target,
- no duplicate receive growth,
- no NPC regressions,
- no migration rollback events.

## Stage 5: General release

Automatic migration may be enabled only after:

- fixture suite passes,
- real wallet copies pass,
- canary succeeds,
- rollback is tested,
- operational documentation is published.

Keep a feature flag such as:

```text
ROUTSTRD_COCO2_AUTO_MIGRATE=0
```

during the initial rollout so operators can require explicit migration.

---

# 22. Acceptance criteria

The migration is complete when all of the following are true:

1. Coco core and SQLite adapter both run at `2.0.0`.
2. Existing Coco 1 and legacy cocod wallets migrate without balance changes.
3. The preflight runs before Coco 2 schema migration and recovery.
4. Recovery work scales with unique proof sets rather than operation rows.
5. The 1,924-row production-shaped fixture does not cause a multi-hour startup.
6. Successful empty restore results become `rolled_back`.
7. Recoverable outputs are never discarded.
8. Unreachable mints do not cause unsafe local rollback.
9. At most one active receive operation exists per fingerprint.
10. Repeated tokens return structured idempotent/terminal results.
11. SDK refund logic stops retrying terminal tokens.
12. Interrupted migrations resume or roll back safely.
13. Pre-upgrade databases remain available for full rollback.
14. NPC functionality is verified or explicitly gated.
15. A second startup after migration performs no redundant receive sweep.
16. Every automatic receive state change is auditable without exposing wallet secrets.

## Recommended implementation priority

```text
1. Dependency and NPC compatibility spike
2. Receive fingerprint specification
3. Read-only preflight inspector
4. Staged migration and rollback framework
5. Deduplicated preflight reconciler
6. Persistent receive guard
7. Structured SDK receive outcomes
8. Coco 2 Manager integration
9. Fixture/canary validation
10. Automatic migration rollout
```

The most important design rule is: **never let Coco 2 open and migrate an old wallet until the raw legacy receive preflight has inspected and reduced its unfinished receive set.**