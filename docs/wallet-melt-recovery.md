# Periodic melt recovery

After startup wallet recovery succeeds, the daemon refreshes in-flight melt
operations every five minutes. Coco finalizes PAID quotes, leaves PENDING quotes
reserved, and rolls back UNPAID quotes. If startup recovery fails, neither the
mint nor melt sweep starts; the daemon logs that explicitly.

- `ROUTSTRD_MELT_SWEEP_INTERVAL_MS` overrides the interval.
- `ROUTSTRD_MELT_SWEEP_DISABLED=1` disables the melt sweep.
- A timeout or transport failure skips the rest of that mint for the current
  pass and applies exponential backoff, from five minutes to one hour.
- Lock races are skipped without a mint penalty. Operation-specific errors are
  logged and retried without backing off other operations at that mint.
- Timed-out work is still tracked: a timeout does not cancel the underlying
  request, and the same operation is not refreshed again until it settles.

## Expired quotes do not prove payment failure

Coco 1.0.1's pending-melt handler is wrapped to handle error 20007 (quote expired).
Expiry alone never authorizes releasing proofs. The sweep asks the mint (NUT-07)
about the proofs the melt actually sent, including swap-send inputs when the
operation required a swap, and applies a strict decision table:

| Melt input states | Result |
| --- | --- |
| every input UNSPENT | rollback: the payment did not happen, restore the inputs |
| every input SPENT | finalize: the mint burned the inputs, so the payment succeeded |
| any input PENDING | stay pending: the HTLC is still live |
| mixed, incomplete, duplicate, malformed, helper unavailable | stay pending + warning |
| proof-state request throws | error propagates, sweep backs off the mint |

### Finalizing an expired, paid melt

Returning `finalize` is not enough: Coco's `MeltBolt11Handler.finalize` asks the
mint for the quote again and throws 20007 at the same purged quote. The wrapper
therefore also wraps `finalize`, re-verifies under the operation lock that every
melt input is SPENT (states can move between checks), and settles the operation
itself:

- change is recovered with NUT-09 restore over the blank change outputs stored
  on the operation (`changeOutputData.keep`). Restore may return a subset in any
  order, so signatures are matched back to their outputs by `B_`;
- the melt inputs are marked spent and the recovered change is unblinded and
  saved as ready proofs. Change that an earlier attempt already saved is not
  saved twice;
- `changeAmount`/`effectiveFee` are derived from the actual melt input amount
  and the recovered change. No preimage is available, so `finalizedData` is
  empty and history shows a finalized operation.

Limits:

- If the quote is gone and restore returns no signatures, the operation is still
  finalized (the inputs are spent, so the sats left) with `changeAmount = 0` and
  a warning. Change outputs are deterministic from the seed, so a later seed
  restore can still find them.
- A restore transport failure leaves the operation pending and nothing spent;
  the sweep retries with mint backoff.
- If Coco changes these handler helpers, installation warns and the melt stays
  pending instead of settling with guessed amounts.

This bridge depends on Coco internals and must be rechecked on upgrades.

## History output changes

Melt history is annotated at read time with `operationState`, including in JSON
output. The stored quote state is unchanged. The CLI labels completed
`rolled_back` operations as `cancelled`, but shows `rolling_back` as `rolling back`:
proof restoration may not have completed. Coco only warns about stranded
`rolling_back` operations at startup; the periodic sweep does not recover them.

No schema migration is required. Rebuild/install and restart the daemon to use
these changes; editing the source tree alone does not update a globally installed
executable.
