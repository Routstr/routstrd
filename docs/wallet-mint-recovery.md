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
partial migration) but the mint still has signatures for outputs derived from
this wallet's seed. A NUT-09 scan is not a complete backup: it cannot recover
proofs that were never derived from this seed, and it can miss outputs beyond
its scan gap. A rebuilt database also lacks the records of tokens you handed
out but that have not yet been redeemed. Keep the original wallet database
when possible; do not use the restored balance to reclaim those tokens.

### How recovery changes the wallet

Recovery scans and checks proofs with the mint before modifying proof storage.
It reconciles by proof identity instead of deleting a keyset to avoid Coco's
duplicate-secret check. Proofs absent from the scan are preserved, and only
proofs explicitly reported `UNSPENT` can be recovered into the spendable
balance. Reconciliation protects proofs linked to existing operations and never
lowers the deterministic output counter. Proof and counter updates are committed
together.

Progress is streamed per keyset. `0 sat` can mean a successful scan that found
nothing to recover; it is not a guarantee that the seed has no other funds.
Failures are reported separately, and a failed keyset does not undo a successful
one. If the CLI loses the connection or you press Ctrl-C, the daemon may still
be working. Check its status before retrying.

The CLI bounds both the wait for response headers and inactivity while reading
progress. It does not apply a total time limit to an active stream: mints can
rate-limit restore batches, so large keysets may take several minutes.
