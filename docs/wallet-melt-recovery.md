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
Expiry alone never authorizes releasing proofs. Rollback requires NUT-07 to
confirm every actual melt input is UNSPENT, including swap-send inputs when the
operation required a swap. Pending, spent, incomplete or unverifiable inputs stay
reserved. Proof-state request exceptions propagate without releasing proofs, so
transport failures still trigger sweep backoff. This bridge depends on Coco
internals and must be rechecked on upgrades.

## History output changes

Melt history is annotated at read time with `operationState`, including in JSON
output. The stored quote state is unchanged. The CLI labels completed
`rolled_back` operations as `cancelled`, but shows `rolling_back` as `rolling back`:
proof restoration may not have completed. Coco only warns about stranded
`rolling_back` operations at startup; the periodic sweep does not recover them.

No schema migration is required. Rebuild/install and restart the daemon to use
these changes; editing the source tree alone does not update a globally installed
executable.
