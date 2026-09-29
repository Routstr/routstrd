# NWC hang: `routstrd nwc status` never returns

Investigation, root cause, fix, build, deployment, and verification.

- **Date:** 2026-09-29
- **Affected command:** `routstrd nwc status` (also `nwc fund` and the auto-refill loop)
- **Base version:** `routstrd` v0.4.11
- **Fix branch / commit:** `fix/nwc-status-hang` — `ceb6d72`
- **Library involved:** `applesauce-wallet-connect@6.2.0` (latest at the time)

---

## 1. Symptom

`routstrd nwc status` hung forever. The local daemon was alive and healthy;
only the NWC endpoint blocked.

```
$ curl -m 6  http://127.0.0.1:8008/health        # 3 ms
$ curl -m 85 http://127.0.0.1:8008/nwc/status    # still pending after 85 s
```

The daemon logs showed the same wedge for manual funding attempts, which never
printed a result:

```
14:14:19 [nwc] Paying invoice via NWC...     <- never completed
14:16:03 [nwc] Paying invoice via NWC...     <- never completed
```

## 2. Call chain

```
cli.ts:2198  nwc status action
  -> handleDaemonCommand("/nwc/status")          utils/daemon-client.ts
       -> ensureDaemonRunning()  (health check, OK)
       -> fetch(...)             (no timeout originally)
  -> GET /nwc/status            daemon/http/index.ts:660
       -> deps.walletAdapter.getNwcStatus()      wallet/index.ts
            -> await wallet.getInfo()            wallet/index.ts
            -> await wallet.getBalance()         wallet/index.ts
```

`wallet` is a `WalletConnect` instance from `applesauce-wallet-connect`.

## 3. Root cause

`applesauce-wallet-connect` applies its per-request timeout **only after** it has
negotiated an encryption scheme from the wallet's `kind:13194` info event:

```js
genericCall(method, params, options = {}) {
  return defer(async () => {
    const encryption = await firstValueFrom(this.encryption$);  // can block forever
    return await WalletRequestFactory.create(...).sign();
  }).pipe(
    switchMap((requestEvent) => {
      const responses$ = this.events$.pipe(
        ...,
        simpleTimeout(options.timeout || this.defaultTimeout),  // 30 s default
      );
      return merge(request$, responses$);
    }),
  );
}
```

If `encryption$` never emits, the `switchMap` (and therefore the timeout) is
never even created. `encryption$` derives from `support$`, which only emits when
the wallet service publishes a `kind:13194` wallet-info event. On a stale or
half-open relay subscription that event never arrives, so `getInfo()` /
`getBalance()` wait forever.

The `"nip04"` fallback in `encryption$` is effectively unreachable (it maps over
`support$`, which is filtered to wallet-info events only). NWC only needs the
info event to *choose* encryption — it could default to nip04 and proceed, since
the service pubkey is already known from the connection URI.

### Proof

A standalone probe against an unreachable relay still had `getInfo()` pending
after 45 s, despite the library's advertised 30 s internal timeout:

```
service set from URI: true
internal defaultTimeout (s): 30
RESULT: getInfo() STILL PENDING after 45.004s — internal timeout never fires
```

A fresh `WalletConnect` to the real relay returned `getInfo` in ~2 s, so the
wallet/relay themselves were fine — the daemon's long-lived relay subscription
had gone stale (the daemon still held a TCP socket to the relay, `67.205.128.242:443`).

## 4. Contributing bugs in routstrd

Even with the library defect, routstrd should not have been able to hang forever:

1. **No timeout in the daemon's NWC calls.** `getNwcStatus`, `fundFromNWC`
   (`wallet.payInvoice`), and the auto-refill loop had no bound.
2. **No timeout on the HTTP route.** `GET /nwc/status` just `await`s the payload;
   so did every other route.
3. **No timeout on the CLI `fetch`.** `_callUrl()` in `utils/daemon-client.ts`
   used `fetch` with no `AbortController`, so a hung daemon blocked the CLI.
4. **Auto-refill never started after a hot connect.** The loop was only started
   during `createWalletAdapter(...)` when a connection string already existed at
   startup. `nwc connect` hot-reloads via `walletAdapter.reconnect()`, which did
   not start the loop — hence no `auto-refill` log lines at all.

## 5. The fix

Branch `fix/nwc-status-hang` (based on tag `v0.4.11`), commit `ceb6d72`.

- **`src/utils/with-timeout.ts`** (new)
  `withTimeout(promise, ms, message)` — `Promise.race` with a clearing timer.

- **`src/daemon/wallet/index.ts`**
  - NWC reads (`get_info` / `get_balance`) are bounded (default 15 s). On timeout,
    the relay pool is closed, a fresh `WalletConnect`/`RelayPool` is created from
    the stored connection string, and the read is retried once.
  - Invoice payments are bounded (default 45 s). A timeout rebuilds the
    connection so later calls recover without a daemon restart; the payment is
    not auto-retried (the invoice is single-use — the caller decides).
  - `ensureAutoRefillLoop()` starts the loop whenever auto-refill is configured,
    even if no wallet is connected yet. `reconnect()` calls it, so a hot
    `nwc connect` now activates refills without a restart.
  - Timeouts are injectable (`nwcReadTimeoutMs`, `nwcPayTimeoutMs`) for tests.

- **`src/daemon/wallet/auto-refill.ts`**
  Takes the bounded `payInvoice` function instead of calling
  `wallet.payInvoice` directly.

- **`src/utils/daemon-client.ts`**
  120 s `AbortController` timeout on CLI daemon requests, with a distinct
  "Daemon request timed out" error instead of a generic connection failure.

- **Tests**
  - `src/daemon/wallet/index.nwc.test.ts` — mocks `applesauce-wallet-connect` /
    `applesauce-relay` and proves: (a) a stale connection is rebuilt and status
    still succeeds, (b) two consecutive hangs produce a bounded error, (c) a hung
    invoice payment returns an error instead of hanging.
  - `src/utils/with-timeout.test.ts` — unit tests for the helper.

Design note: this is defense-in-depth on routstrd's side. A request that stalls
now fails in bounded time and self-heals instead of blocking a user command or
the daemon's auto-refill loop.

## 6. Build, install, restart

```sh
cd /root/workspace/routstrd
bun run build        # dist/index.js + dist/daemon/index.js
```

The original global package was backed up first:

```
/root/routstrd-backup-20260929-155718
# path also stored in /root/.routstrd-build-backup-path
```

The new `dist/` (and matching `src/` files) were copied into
`/root/.bun/install/global/node_modules/routstrd/`, then:

```sh
routstrd restart
```

Old daemon PID `90` -> new PID `21452`; `/health` was polled until healthy
before the command returned (~2 s).

## 7. Verification

```
$ time routstrd nwc status
{
  "connected": true,
  "alias": "Megalithic.me",
  "network": "mainnet",
  "balance": 60876,
  "autoRefill": { "threshold": 30000, "amount": 21000, "cooldownMs": 30000 }
}
real  0m1.540s
```

```
$ time curl -m30 http://127.0.0.1:8008/nwc/status
real  0m1.347s
```

The auto-refill loop now starts and actually runs:

```
[wallet] Auto-refill enabled: threshold=30000 sats, amount=21000 sats ...
[nwc] NWC wallet connected. Relay: wss://relay-nwc.rizful.com/v1 ...
[auto-refill] Paying invoice via NWC...
[auto-refill] Successfully refilled 21000 sats. Preimage: 49b20b7b...
```

`routstrd status` reports `wallet: connected`, balance `22820` sats.

## 8. Test results

New tests: **6 pass, 0 fail**. `bunx tsc --noEmit` is clean.

The full suite still reports 4 failures that are **pre-existing on a clean
`v0.4.11`** and unrelated to this change:

- 3 in `tests/utils/daemon-client.test.ts` — `tests/integrations/pi.test.ts`
  calls `mock.module("../../src/utils/daemon-client", ...)` and the mock leaks
  across files depending on run order.
- 1 in `src/daemon/wallet/diagnostics.test.ts` — the unreadable-file test relies
  on `chmod 000`, which does not block reads when running as root.

Confirmed by stashing the fix and running the suite on the pristine tag: same
4 failures.

## 9. Rollback

```sh
cp /root/routstrd-backup-20260929-155718/dist/index.js \
   /root/.bun/install/global/node_modules/routstrd/dist/index.js
cp /root/routstrd-backup-20260929-155718/dist/daemon/index.js \
   /root/.bun/install/global/node_modules/routstrd/dist/daemon/index.js
routstrd restart
```

## 10. Upstream recommendation

`applesauce-wallet-connect@6.2.0` still has this defect. Suggested fixes
upstream:

1. Apply the request timeout around the **whole** pipeline, e.g. move
   `simpleTimeout` so it wraps `defer(async () => { ... }).pipe(switchMap(...))`,
   not just the `responses$` stream inside it.
2. Make the `"nip04"` encryption fallback reachable (e.g. `startWith` on
   `support$`, or default to nip04 when wallet info is not yet known).
3. Let `getInfo()` / `getBalance()` forward a timeout / `AbortSignal` to
   `genericCall`.
