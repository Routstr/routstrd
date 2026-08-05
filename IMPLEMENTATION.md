# Migrate wallet storage from `~/.cocod` to `~/.routstrd/wallet`

Task: [`routstrd-migrate-cocod-to-routstrd-files`](https://github.com/nodestrich/routstrd)
Event ID: `2f420644005154c5b106017c4a753854bb2660ba834cde7e6e267532cb5448e9`
Priority: 997 · Status: open

---

## Baseline

This plan is based on `coco-integration` at `86ac688` (after the default-mint, NPC/npubx.cash, and Windows-support changes).

The task branch is currently based on `04f8c22`; rebase it onto the latest `coco-integration` before implementing this plan.

## Goal

Move the in-process Cashu wallet's persistent data from:

```text
~/.cocod/config.json
~/.cocod/coco.db
```

to:

```text
~/.routstrd/wallet/config.json
~/.routstrd/wallet/coco.db
```

The migration must preserve the mnemonic, proofs, default mint, and NPC identity. Existing users must not accidentally get a new wallet, and `cocod` and routstrd must never open the same database concurrently.

Fresh installs must use `~/.routstrd/wallet` immediately. Existing installs must be migrated automatically and safely; merely continuing to run from `~/.cocod` is not sufficient for this task.

---

## Important corrections to the previous plan

### 1. Do not rename or migrate `cocod.sock`

The in-process `coco-core` wallet does not expose a Unix socket. `cocod.sock` belongs to the legacy external `cocod` daemon and is used only to determine whether that daemon is still alive.

There should therefore be no `wallet.sock`. Do not copy a socket inode into the new directory.

### 2. Keep legacy-process paths separate from wallet-data paths

On the current base, `src/daemon/wallet/coco-client.ts` derives all of these from one `CONFIG_DIR`:

- wallet config and database;
- legacy cocod socket;
- legacy cocod PID/process lock.

That coupling must be removed. After migration:

- wallet data comes from `~/.routstrd/wallet`;
- probes and shutdown logic for an external legacy cocod continue to use `~/.cocod/cocod.sock` and `~/.cocod/cocod.pid`;
- routstrd uses `~/.routstrd/wallet/wallet.pid` as the in-process wallet lock.

While routstrd owns the migrated wallet, it should also retain the existing legacy-cocod exclusion mechanism (claiming the legacy `cocod.pid`) so an old cocod cannot be started against a stale or partially migrated legacy wallet. Acquisition and release of both locks must be rollback-safe.

### 3. Do not rename `cocodPath`

`RoutstrdConfig.cocodPath` is an executable path for the external compatibility client, not a wallet storage path. Renaming it to `walletPath` would change its meaning and would not help this migration.

The current daemon creates `createCocoClient()` directly and injects it into `createWalletAdapter()`, so `cocodPath` is effectively bypassed on the normal in-process path. Cleanup or removal of that compatibility setting is a separate task.

### 4. Do not implement fallback as the steady state

A resolver that permanently falls back to `~/.cocod` does not move the data. Legacy detection is needed to initiate migration, but successful startup should resolve to the canonical directory afterward.

### 5. Account for the updated base

The latest `coco-integration` adds:

- `defaultMintUrl` persistence in the wallet's `config.json`;
- the NPC plugin, whose Nostr identity is derived from the same mnemonic;
- `src/daemon/wallet/coco-client.npc.test.ts`;
- Windows support and `USERPROFILE` fallback.

Migration must preserve the complete config JSON rather than reconstructing selected fields. Path construction must use `path.join` rather than hard-coded `/` separators.

---

## Current runtime path references on the latest base

### Wallet data and legacy process coordination

| File | Current responsibility | Required change |
|---|---|---|
| `src/daemon/wallet/coco-client.ts` | Uses one `.cocod` directory for config, DB, socket, and PID; owns the in-process wallet and legacy-cocod guard | Split canonical data paths from legacy process paths; migrate before opening the DB; use `wallet.pid` for the in-process lock |
| `src/daemon/wallet/cocod-client.ts` | External cocod compatibility client; defaults to `.cocod/cocod.sock` | Keep legacy defaults and clarify that they are external-cocod paths |
| `src/cli.ts` | Initializes `.cocod`; two restart paths wait on `.cocod/cocod.pid` | Initialize/migrate the canonical wallet and wait on `wallet.pid` |
| `src/utils/config.ts` | Defines `~/.routstrd`, but no wallet subdirectory | Export canonical and legacy wallet/process path helpers or constants |
| `src/daemon/index.ts` | Calls `createCocoClient()` before building the adapter | Ensure migration occurs before the client opens the DB |

### Tests and documentation

| File | Required update |
|---|---|
| `src/cli.test.ts` | Change fresh-wallet expectations and add migration coverage |
| `src/daemon/wallet/coco-client.test.ts` | Update data/lock paths and add migration/dual-lock tests |
| `src/daemon/wallet/coco-client.npc.test.ts` | Use the canonical wallet layout in fixtures; verify migrated mnemonic/config still drives NPC identity |
| `README.md` | Document the new location and migration behavior; retain legacy cocod terminology only where discussing compatibility |
| `SKILL.md` | Update wallet storage and environment-variable documentation |

The fixture `src/daemon/wallet/fixtures/cocod-0.0.24-wallet.db.gz` keeps its name because it records the fixture's provenance.

---

## Target path model

Define the path model in one dependency-light module (for example `src/daemon/wallet/paths.ts`, or in `src/utils/config.ts` if that does not introduce a cycle):

```text
ROUTSTRD config root       process.env.ROUTSTRD_DIR || ~/.routstrd
canonical wallet directory process.env.ROUTSTRD_WALLET_DIR || <config root>/wallet
canonical wallet config    <wallet directory>/config.json
canonical wallet database  <wallet directory>/coco.db
canonical wallet lock      process.env.ROUTSTRD_WALLET_PID || <wallet directory>/wallet.pid

legacy cocod directory     process.env.COCOD_DIR || ~/.cocod
legacy cocod socket        process.env.COCOD_SOCKET || <legacy directory>/cocod.sock
legacy cocod PID           process.env.COCOD_PID || <legacy directory>/cocod.pid
```

Use `HOME` with `USERPROFILE` fallback, matching the updated Windows-support base. Use functions or injectable path objects where tests need to change environment variables after module import.

`COCOD_DIR`, `COCOD_SOCKET`, and `COCOD_PID` remain compatibility controls for locating an old external cocod. They must not redirect the new in-process wallet away from `~/.routstrd/wallet`. `ROUTSTRD_WALLET_DIR` is the new explicit data-directory override.

---

## Implementation plan

### Phase 1 — Centralize and separate paths

1. Add the canonical wallet and legacy cocod path definitions above.
2. Remove the local `.cocod` path construction from `coco-client.ts` and `cli.ts`.
3. Change `CreateCocoClientOptions` so tests/tooling can independently override:
   - wallet data directory;
   - wallet lock path;
   - legacy cocod socket and PID paths.
4. Keep `cocod-client.ts` pointed at the legacy socket. Do not make it import a resolver that prefers the new wallet directory.

### Phase 2 — Add a safe automatic migration primitive

Add an idempotent `migrateLegacyWallet()` helper with injectable paths/filesystem operations for tests.

Preconditions and behavior:

1. If the canonical wallet already contains both `config.json` and `coco.db`, return `already-current` and do not touch legacy data.
2. If neither canonical nor legacy wallet data exists, return `fresh`; initialization will create the canonical directory.
3. If only the legacy wallet exists:
   - first verify that legacy cocod is not running using the existing PID and socket guard;
   - create a private staging directory under `~/.routstrd` with mode `0700`;
   - copy the complete `config.json` and `coco.db` into staging without parsing or rewriting them;
   - apply `0600` to both files;
   - validate that the staged files exist and have the expected byte sizes;
   - atomically rename the staged directory to `wallet`;
   - only after the canonical directory is committed, remove the legacy `config.json` and `coco.db`;
   - never copy `cocod.sock` or `cocod.pid`.
4. If canonical storage is partial, legacy storage is partial, both contain wallet data, or files conflict, stop with an actionable error. Never merge databases and never generate a new mnemonic over an ambiguous state.
5. Clean up an uncommitted staging directory after failure. A committed canonical wallet remains authoritative if cleanup of the old files fails; report that cleanup warning clearly.

The migration should preserve unknown config fields, including `defaultMintUrl`, and preserve the database byte-for-byte. This also preserves the NPC identity because that identity is derived from the mnemonic.

A staging copy plus atomic directory rename is preferred over two independent file renames: a crash must not expose a half-created canonical wallet. Copying also permits a clear rollback before commit and supports a legacy directory located on another filesystem through `COCOD_DIR`.

### Phase 3 — Run migration from every wallet-opening path

1. **CLI onboarding/init:** run migration before `initializeWallet()`. Only initialize a new mnemonic when migration reports `fresh`.
2. **Daemon direct startup:** run migration before `createCocoClient()` opens `coco.db`. This covers users who invoke the daemon without rerunning onboarding.
3. **Start/restart/update/service paths:** retain `stopLegacyCocod()` before migration/startup where those paths already stop legacy cocod. Direct daemon startup should refuse with the existing actionable error rather than silently running two wallet engines.
4. Print a concise success message showing old and new directories, but never print config contents or the mnemonic during migration.

A separate `routstrd wallet migrate` command is optional as a manual recovery/preview entry point, but it must call the same migration primitive. It is not a substitute for automatic migration.

### Phase 4 — Separate process locking

Refactor the current `claimLegacyCocodPidFile()` behavior into explicit responsibilities:

1. Claim `wallet.pid` for the lifetime of the in-process wallet to prevent two routstrd wallet instances from opening `coco.db`.
2. Continue claiming the legacy `cocod.pid` while routstrd is active, after verifying no real cocod owns it, to prevent an old cocod from starting.
3. If either claim fails, release any claim already acquired before returning the error.
4. On `CocodClient.dispose()`, startup failure, and daemon shutdown, release only PID files still owned by the current process.
5. Keep `stopLegacyCocod()` and `assertLegacyCocodNotRunning()` operating only on legacy cocod paths.
6. Update both PID-release waits in `src/cli.ts` (`restartDaemonsAfterUpdate` and `restart`) to wait for the canonical `wallet.pid` rather than `.cocod/cocod.pid`.

There is no canonical wallet socket.

### Phase 5 — Update initialization and client defaults

1. Make `initializeWallet()` default to the canonical wallet directory.
2. Preserve directory mode `0700` and config mode `0600` on both migrated and fresh wallets.
3. In `createCocoClient()`, derive `config.json` and `coco.db` from the canonical wallet directory, but take legacy guard paths separately.
4. Update the wallet-access comment near `unlock()` to reference `~/.routstrd/wallet/config.json`.
5. Leave `CocodClient`, `resolveCocodExecutable()`, and `cocodPath` compatibility behavior unchanged.

### Phase 6 — Tests

Add or update tests for:

- fresh initialization creates `~/.routstrd/wallet`, not `.cocod`;
- a legacy config and database migrate byte-for-byte;
- `defaultMintUrl` and unknown config fields survive migration;
- the NPC-derived identity is unchanged after migration;
- migration never copies socket or PID files;
- migration refuses while a real legacy cocod is running;
- stale legacy socket/PID handling remains safe;
- an existing complete canonical wallet wins without modifying it;
- partial canonical, partial legacy, and conflicting dual-wallet states fail without generating a mnemonic;
- staging cleanup and retry after an interrupted migration;
- custom `ROUTSTRD_DIR`, `ROUTSTRD_WALLET_DIR`, and legacy `COCOD_DIR` paths;
- Windows-compatible path construction;
- acquiring the second process lock rolls back the first on failure;
- `dispose()` releases both owned locks and does not unlink another process's lock;
- both CLI restart paths wait for `wallet.pid`.

Keep `cocod-0.0.24-wallet.db.gz` unchanged and continue using it to prove the migrated database opens successfully with the current in-process wallet.

### Phase 7 — Documentation

Update `README.md` and `SKILL.md` to state:

- wallet data is stored in `~/.routstrd/wallet`;
- existing `~/.cocod` data is migrated automatically on first startup;
- users must back up the mnemonic before migration;
- `ROUTSTRD_WALLET_DIR` overrides the canonical wallet directory;
- `COCOD_DIR`, `COCOD_SOCKET`, `COCOD_PID`, and `cocodPath` refer only to legacy external-cocod compatibility.

Do not replace every use of the word `cocod`: references to the external daemon, compatibility client, legacy guard, package, and fixture are still accurate.

---

## Acceptance criteria

- A fresh install creates wallet data only under `~/.routstrd/wallet`.
- Starting from a valid `.cocod` wallet results in the same config and database under the canonical directory without changing balances, mnemonic-derived NPC identity, or default mint.
- No startup path silently creates a new mnemonic when recoverable legacy data exists.
- A running legacy cocod blocks migration and database opening.
- The new wallet directory contains no copied Unix socket and uses `wallet.pid` only as an in-process lock.
- Legacy cocod probing and exclusion continue to use `.cocod/cocod.sock` and `.cocod/cocod.pid`.
- The implementation works with `USERPROFILE`/Windows path construction and custom directory overrides.
- All wallet, CLI, typecheck, and build tests pass on the rebased `coco-integration` branch.

---

## Suggested commit sequence

1. `refactor(wallet): separate routstrd wallet paths from legacy cocod paths`
2. `feat(wallet): atomically migrate legacy cocod wallet data`
3. `fix(wallet): use independent routstrd and legacy cocod process locks`
4. `test(wallet): cover migration, conflicts, NPC identity, and lock rollback`
5. `docs: document routstrd wallet storage and legacy migration`
