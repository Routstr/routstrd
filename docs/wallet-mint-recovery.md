# Mint quote recovery: scope and troubleshooting

`routstrd wallet recover` explicitly retries mint operations through coco using
**their existing stored outputs**. It can restore signatures when a quote is
already issued, and reopen failed operations when explicitly requested:

```sh
routstrd history --json
routstrd wallet recover --op <operationId> --include-failed
```

Failed operations require explicit IDs over both HTTP and the CLI. A successful
re-run on an already finalized operation is a no-op. Requests that exceed their
wait budget are not cancelled; explicit retries skip the operation while the
underlying work is outstanding.

## What this fixes—and what it does not

Coco already checks pending quotes on startup and the daemon periodically
refreshes them. A quote paid while the daemon was offline does not, by itself,
require a new issuance implementation.

This change makes normal cleanup confirm UNPAID with the mint before failing an
expired quote. PAID, ISSUED and unverified quotes remain pending. It also gives
operators a recovery path for operations previously marked failed.

It does **not** replace rejected outputs with fresh outputs on an active keyset.
An inactive-keyset rejection can therefore remain retryable with zero recovery.
Recovery reports coco's persisted mint error when available, rather than only a
generic “remains pending” error.

Do not infer that the production incidents were caused by keyset retirement.
Before claiming those incidents are fixed, collect:

- The affected operation IDs, quote IDs, state and persisted `error`.
- A fresh remote quote state and, where provided, paid/issued amounts.
- The keyset IDs in the stored outputs and the mint's current keyset metadata.
- A reproduction showing existing recovery fails and the proposed fix succeeds.

Inspect persisted operation data through a read-only database copy; do not edit
rows or run recovery scripts concurrently with a daemon against the same wallet.
Never share the mnemonic, output secrets, or full wallet database in a PR.

A future fresh-output path must preserve original outputs for uncertain issuance
and NUT-09 restore, allocate fresh deterministic counters safely, and coordinate
with coco's watcher/processor. It needs its own integration tests before handling
real funds.

## Cleanup preview and force

`wallet cleanup --dry-run` is local-only: it reports `mintQuoteCandidates`, not
confirmed failures. `failedMintQuotes` and `leftForRecovery` are zero because no
mint check or cleanup transition was performed. Send/melt counts remain planned
cleanup counts in dry-run mode.

`--force` deliberately bypasses mint confirmation and can strand paid sats in a
failed operation. Prefer normal cleanup. Forced operations can be retried with
`--op <operationId> --include-failed`, but recovery still depends on the mint
accepting their stored outputs or restoring their signatures.

## Integration and release notes

The reopen helper uses private coco-core 1.0.1 methods. Retain real-Manager and
HTTP fake-mint coverage, use frozen dependency installs, and re-run integration
tests on coco upgrades. A controlled low-value live-mint smoke test remains
recommended before release.

PR #118 removed `cocod-client.ts`; this branch now carries that integration, so
the recovery and cleanup contracts live in `wallet-client.ts` and there is no
legacy cocod mint-recovery stub.

## Recovering a mint's proofs (NUT-09)

The command above retries mint *quotes*. A separate command re-derives the
wallet's proofs for a mint from the mint's NUT-09 restore endpoint:

```sh
routstrd wallet recover-mint --mint-url https://mint.example.com
```

Use it when local proof state was lost (restored seed, rebuilt database,
partial migration) but the mint still holds signed proofs. Restored proofs are
checked with NUT-07 first, so proofs the mint already sees as spent are not
resurrected. Progress streams per keyset and the command fails if any keyset
fails.

### Why routstrd drives the restore itself

`coco.wallet.restore()` persists the restored proofs with
`proofService.saveProofs()` without first deleting the proofs already stored for
that keyset, and the sqlite repository rejects duplicate secrets
(`Proof with secret already exists`). That makes `wallet.restore()` unusable on
any mint that already has local proofs — the normal case for a mint being
recovered. Both `@cashu/coco-core@1.0.1` and `2.0.0` behave this way.

`recoverMintProofs()` therefore drives coco's per-keyset restore itself and:

- wipes the keyset's proofs immediately before the restored batch is written.
  The wipe must be unconditional and state-inclusive:
  `getProofsByKeysetId()` only returns *ready* proofs, so a ready-only check
  leaves spent/inflight rows behind, and their secrets still collide on save;
- puts the pre-restore snapshot back if the restore **fails partway**, since a
  half-finished restore is the only case where local data can be lost. A
  restore that completes is never second-guessed: the mint is authoritative
  about its own proofs, and it legitimately persists nothing when every proof
  for a keyset is already spent;
- refuses to run while proofs are reserved by an operation that is still open,
  because the wipe would delete them. Orphaned reservations (no owning
  operation, left by an interrupted run) do not block — reconciling them
  against the mint is exactly what recovery is for;
- skips a retired keyset the mint no longer serves when nothing is stored
  locally, instead of failing the whole run over it;
- pauses the watcher/processor/subscription services for the duration, since
  they mutate proofs and counters outside public client calls.

Progress streams per keyset with the unspent value the mint confirmed, so a
recovery that finds nothing still reports `0 sat` rather than an error. A
keyset can hold thousands of proofs and coco restores it in one opaque call, so
the daemon emits a heartbeat every 30s while a keyset is in flight.

The CLI bounds that stream by inactivity, not total duration: mints rate-limit
NUT-09 batches (minibits allows roughly one request every three seconds), so a
large keyset legitimately takes minutes, and a stream that keeps making
progress must not be cut off. Ctrl-C only drops the CLI — the daemon finishes
the restore, because recovery must never be interrupted halfway.

The upstream fix that would let this delegate to `wallet.restore()` again is to
call `proofService.wipeProofsByKeysetId(mintUrl, keysetId)` inside
`WalletRestoreService.restoreKeyset()` before `saveProofs()`.
