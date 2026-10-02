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

## Wallet doctor

`routstrd wallet doctor` runs read-only health checks before the legacy
migration diagnosis:

1. **Mint reachability** — a NUT-06 probe against every trusted mint.
2. **Recent unpaid quotes** — pending quotes from the last hour the mint
   still reports UNPAID (an invoice awaiting payment; informational).
3. **Paid but not issued** — the stuck scenario this recovery feature
   fixes. Each finding prints its `wallet recover --op <id>` remediation,
   with `--include-failed` when the operation must be re-opened first.
4. **Stuck melts** — prepared melts holding reserved proofs, in-flight
   melts, and failed melts whose input proofs were never released.

The doctor never mutates wallet state: quote checks are plain NUT-04 reads,
not coco's observe-and-persist path, and remediation is always left to the
operator. It exits non-zero when money is provably at risk (unreachable
mint, paid-but-unissued quote, failed melt with locked proofs) or the
migration diagnosis finds a conflict, so it can gate scripts. When the
daemon is down only the offline migration section runs.

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

PR #118 removes `cocod-client.ts`. When integrating that change, move recovery
and cleanup contracts into its replacement `wallet-client.ts`, rename HTTP error
references accordingly, and make recovery mandatory for the in-process client.
This follow-up does not pull in #118's unrelated removal.
