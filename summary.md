# routstrd `service install` Bug Investigation Summary

## Problem Reported
The `routstrd service install` command is not working, silently failing to start or persist the daemon.

## Investigation Findings

When running `routstrd service install` from source (`bun src/index.ts`), the command appears to exit quickly with no output. When running from the built dist, PM2 starts but the daemon process immediately disappears.

Multiple bugs were discovered during investigation.

---

## Bug 1: `Bun.resolveSync` Used Incorrectly (CLI Broken at Runtime)

**File:** `src/cli.ts` (in the `service install` command handler)

**Broken code:**
```typescript
let daemonPath: string;
try {
  // Try to resolve relative to this file first (works in dev and global)
  daemonPath = Bun.resolveSync("./daemon/index.js", import.meta.url);
} catch (e) {
  // Fallback for some bundling scenarios
  const path = require("path");
  daemonPath = path.join(path.dirname(import.meta.url).replace("file://", ""), "daemon", "index.js");
}
```

**Problem:**
`Bun.resolveSync(moduleID, parent)` requires `parent` to be a **directory path**, not a `file://` URL. When `import.meta.url` (which is `file:///path/to/cli.ts`) is passed as the parent, `Bun.resolveSync` throws immediately:

```
Cannot find module './daemon/index.js' from 'file:///home/user42/.../cli.ts'
```

This means the `try` block always fails and execution falls through to the fallback path. The fallback uses `require("path")` which works in Bun but the resulting path is wrong.

**Evidence:**
```bash
$ bun -e "console.log(Bun.resolveSync('./daemon/index.js', import.meta.url))"
error: Cannot find module './daemon/index.js' from 'file:///.../[eval]'

$ # Works correctly with a directory:
$ bun -e "console.log(Bun.resolveSync('./daemon/index.js', 'file:///home/user42/projects/routstr_main/routstrd/src'))"
/home/user42/projects/routstr_main/routstrd/src/daemon/index.js
```

Even when `Bun.resolveSync` is fixed, `dist/index.js` still needs to resolve the correct path because after bundling, `import.meta.url` points to the bundled file, not the original source.

---

## Bug 2: Dev vs Built Path Resolution Divergence

After `bun run build`, the `dist/` directory contains:
- `dist/index.js` — the CLI bundle
- `dist/daemon/index.js` — the daemon bundle

When running `bun dist/index.js service install`:
- `import.meta.url` = `file:///.../dist/index.js`
- `Bun.resolveSync("./daemon/index.js", new URL(".", import.meta.url).pathname)` resolves to `dist/daemon/index.js` ✓

When running `bun src/index.ts service install` (development):
- `import.meta.url` = `file:///.../src/index.ts`  
- `Bun.resolveSync` would try to resolve `src/daemon/index.js`, which does not exist (the source is `.ts`, not bundled)
- The daemon source is actually at `src/daemon/index.ts`

This means the path resolution logic must differentiate between:
1. **Development mode** (`bun src/index.ts`) → the daemon should be started via `bun run src/daemon/index.ts`
2. **Production/bundled mode** (`bun dist/index.js`) → the daemon is `dist/daemon/index.js`

---

## Bug 3: Daemon Crashes Immediately on Startup (Missing Wallet Initialization)

Even after PM2 starts the daemon, it **crashes immediately** and disappears from `pm2 list`.

**Evidence:**
```bash
$ pm2 start "dist/daemon/index.js" --name routstrd --interpreter bun
[PM2] Starting ... Done.
$ pm2 describe routstrd
[PM2][WARN] routstrd doesn't exist   # <-- already crashed
```

The daemon (`src/daemon/index.ts`) creates a `cocod` wallet client immediately:
```typescript
const walletClient = createCocodClient({ cocodPath: config.cocodPath });
const walletAdapter = await createWalletAdapter({
  cocodPath: config.cocodPath,
  walletClient,
});
```

If **cocod is not installed or initialized**, this throws an unhandled error, the process exits, and PM2 removes the crashed process. PM2 doesn't restart it because the crash happens so fast.

The `service install` command **never checks** if cocod is installed before spawning the daemon via PM2. The `onboard`/`initDaemon` sequence does this check, but `service install` skips it entirely.

---

## Bug 4: Bundled Build Has Native Module Issues (Secondary)

`bun run build` throws resolve errors when `@noble/hashes/crypto` is missing (node_modules inconsistency). After `bun install`, the build succeeds, but this indicates the lockfile was stale/ignored.

---

## Bug 5: PM2 Start Command Lacks Working Directory

The PM2 start command uses an absolute path, but the daemon writes its PID file and opens its database relative to the current working directory. If PM2 starts it with a different CWD (which it does — PM2's internal CWD), the PID file and DB end up in the wrong place or fail to write.

```typescript
execSync(`pm2 start "${daemonPath}" --name routstrd --interpreter bun`, ...)
```

Missing: `--cwd <dir>` to ensure the daemon runs from the expected directory.

---

## Root Cause Summary

The `service install` command fails due to a **cascade of issues**:

1. **Path resolution is broken** (`Bun.resolveSync` called with invalid parent)
2. **No cocod readiness check** before spawning the daemon under PM2
3. **No CWD provided to PM2**, so daemon state files may write to wrong locations
4. **Daemon crashes immediately** if wallet isn't initialized, and PM2 silently removes it

---

## Reproduction Steps

1. Fresh clone / clean environment (or just ensure no PM2 process is running)
2. `bun src/index.ts service install`
   - Expected: installs PM2 service, daemon starts and persists
   - Actual: command may appear to work but PM2 process immediately crashes/disappears
3. `pm2 describe routstrd` → "doesn't exist"
4. `pm2 logs routstrd` → empty or abruptly ended

---

## Suggested Fixes

### Fix 1: Correct path resolution in `service install`
```typescript
const baseDir = new URL(".", import.meta.url).pathname;
let daemonPath: string;
try {
  daemonPath = Bun.resolveSync("./daemon/index.js", baseDir);
} catch (e) {
  // Fallback for ESM/bundler compat
  daemonPath = path.join(baseDir, "daemon", "index.js");
}
```

Better yet: differentiate dev vs bundled mode. In dev, the daemon should be started as `bun run src/daemon/index.ts`, not as a pre-built `.js` file.

### Fix 2: Check cocod before asking PM2 to start
```typescript
if (!(await isCocodInstalled(config.cocodPath))) {
  console.error("cocod is not installed. Run 'routstrd onboard' first.");
  process.exit(1);
}
```

### Fix 3: Pass `--cwd` to PM2
```typescript
execSync(
  `pm2 start "${daemonPath}" --name routstrd --interpreter bun --cwd "${process.cwd()}"`,
  { stdio: "inherit" }
);
```

### Fix 4: Provide better error visibility
The PM2 start should capture stderr or use `pm2 logs` output so users see why the daemon crashed.

---

## Related Files

- `src/cli.ts` — `service install` command handler
- `src/daemon/index.ts` — daemon entrypoint, crashes without initialized wallet
- `src/start-daemon.ts` — dev-mode daemon launcher (uses `bun run src/daemon/index.ts`)
- `src/daemon/wallet/cocod-client.ts` — `isCocodInstalled()` check
