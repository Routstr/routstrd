# routstrd `service install` Bug Investigation — Update

## Executive Summary

All 5 bugs from the initial `summary.md` were verified empirically. However, the investigation uncovered **2 additional critical bugs** that were not in the original summary:

1. **PM2 `--interpreter bun` is broken in PM2 v6.x** — this causes *any* Bun script (even `console.log("hello")`) to exit immediately with no logs.
2. **`import.meta.main` guard in `src/daemon/index.ts` prevents `main()` from executing when PM2 wraps the script** (which PM2 does by default when using `--interpreter node`).

The original summary identified the correct symptoms (daemon disappears from PM2) but attributed them primarily to missing cocod initialization. In reality, **the daemon cannot start under PM2 at all** due to the PM2/Bun interoperability bugs, regardless of cocod state.

---

## Bug-by-Bug Verification

### Bug 1: `Bun.resolveSync` Used Incorrectly — ✅ CONFIRMED

**Location:** `src/cli.ts`, `service install` command handler

**Broken code:**
```typescript
daemonPath = Bun.resolveSync("./daemon/index.js", import.meta.url);
```

**Evidence:**
```bash
$ cat > src/test-resolve.ts << 'EOF'
console.log("import.meta.url:", import.meta.url);
try {
  const p = Bun.resolveSync("./daemon/index.js", import.meta.url);
  console.log("OK:", p);
} catch (e: any) {
  console.log("FAILED:", e.message);
}
EOF

$ bun run src/test-resolve.ts
import.meta.url: file:///home/user42/.../src/test-resolve.ts
FAILED: Cannot find module './daemon/index.js' from 'file:///home/user42/.../src/test-resolve.ts'
```

`Bun.resolveSync(moduleID, parent)` requires `parent` to be a **directory path**. `import.meta.url` is a `file://` URL pointing to the source file, not its directory. This causes an immediate throw, so execution always falls through to the `catch` block.

**Fix (partial):**
```typescript
const baseDir = new URL(".", import.meta.url).pathname;
daemonPath = Bun.resolveSync("./daemon/index.js", baseDir); // works
```

---

### Bug 2: Dev vs Built Path Resolution Divergence — ✅ CONFIRMED

**Evidence:**

**Development mode** (`bun run src/test-resolve.ts`):
```
baseDir: /home/user42/.../src/
resolveSync with dir path: /home/user42/.../src/daemon/index.ts
```
Resolves to `.ts` source file because Bun resolves `.js` → `.ts` transparently in dev.

**Built mode** (`bun run dist/test-resolve.js`):
```
baseDir: /home/user42/.../dist/
resolveSync with dir path: /home/user42/.../dist/daemon/index.js
```
Resolves to the bundled `.js` artifact.

**Fallback path behavior:**
Because Bug 1 always throws, the fallback path is always used:
```typescript
const path = require("path");
daemonPath = path.join(path.dirname(import.meta.url).replace("file://", ""), "daemon", "index.js");
```

- In **dev**: produces `.../src/daemon/index.js` → **does not exist** (source is `.ts`)
- In **built**: produces `.../dist/daemon/index.js` → **exists** if `bun run build` was run

**User-facing impact:**
```bash
$ bun src/index.ts service install
Could not find daemon at .../src/daemon/index.js. Did you run 'bun run build'?
```
This message is misleading. The user may want to run from source without building.

---

### Bug 3: Daemon Crashes Immediately on Startup — ⚠️ PARTIALLY CONFIRMED

**Original claim:** Daemon crashes because of missing wallet/cocod initialization.

**Findings:**

1. **If cocod is not installed/initialized, the daemon DOES crash** — `createWalletAdapter()` throws an unhandled error in `src/daemon/index.ts`:
   ```typescript
   const walletClient = createCocodClient({ cocodPath: config.cocodPath });
   const walletAdapter = await createWalletAdapter({ cocodPath: config.cocodPath, walletClient });
   ```
   This is a real bug and `service install` should check `isCocodInstalled()` before spawning PM2 (the `start` command already does this check; `service install` does not).

2. **However, the daemon ALSO cannot start under PM2 even when cocod IS ready** due to two PM2-specific bugs (see NEW BUGS below).

**Evidence that daemon runs fine without PM2:**
```bash
$ bun dist/daemon/index.js --port 18008
[ProviderManager] Hydrated from store: ...
Routstr daemon listening on http://localhost:18008
Bootstrapping providers...
Bootstrapped 22 providers
...
```
The daemon starts successfully and stays alive when run directly with `bun`.

---

### Bug 4: Bundled Build Has Native Module Issues — ❌ NOT REPRODUCED

**Claim:** `bun run build` throws resolve errors for `@noble/hashes/crypto`.

**Evidence:**
```bash
$ bun run build
  index.js  1274.27 KB
[25ms] bundle 486 modules
  index.js  1257.17 KB
[22ms] bundle 416 modules
```
Build completed successfully. The lockfile issue may have been transient or environment-specific.

---

### Bug 5: PM2 Start Command Lacks Working Directory — ⚠️ PARTIALLY CONFIRMED

**Claim:** Missing `--cwd` causes PID file and DB to write to wrong locations.

**Evidence:**
```typescript
// src/utils/config.ts
export const CONFIG_DIR = process.env.ROUTSTRD_DIR || `${HOME}/.routstrd`;
export const PID_FILE = process.env.ROUTSTRD_PID || `${CONFIG_DIR}/routstrd.pid`;
export const DB_PATH = `${CONFIG_DIR}/routstr.db`;
```

Both `PID_FILE` and `DB_PATH` are **absolute paths** under `~/.routstrd` (or `$ROUTSTRD_DIR`), so they are **not affected by CWD**.

However:
- Missing `--cwd` can still affect **relative imports** or **runtime file resolution** inside the daemon.
- In PM2 v6, the default `exec cwd` was observed to be the project directory anyway.
- Explicit `--cwd` is still defensive and should be added.

**Recommendation:** Add `--cwd "${process.cwd()}"` to the PM2 start command for safety, but this is not the root cause of the disappearing process.

---

## 🆕 New Critical Bugs Discovered

### New Bug A: PM2 `--interpreter bun` is Broken in PM2 v6.x

**Environment:** PM2 v6.0.14, Bun v1.1.42, Node.js v24.15.0

**Symptom:** Any Bun script started with `pm2 start ... --interpreter bun` shows as "online" for ~0 seconds, then immediately disappears. No logs are written.

**Evidence:**
```bash
$ cat > dist/test-main.js << 'EOF'
console.log("hello from bun");
setInterval(() => console.log("alive", Date.now()), 2000);
EOF

$ pm2 start dist/test-main.js --name test-bun --interpreter bun
[PM2] Starting ... Done.
# Shows PID, 0s uptime, online

$ sleep 2
$ pm2 describe test-bun
[PM2][WARN] test-bun doesn't exist

$ cat ~/.pm2/logs/test-bun-out.log
# EMPTY — 0 bytes
```

**Same script with `--interpreter node` works fine and stays alive.**

**Root cause:** PM2 v6.x has known Bun interpreter compatibility issues:
- https://github.com/Unitech/pm2/issues/5967
- https://github.com/oven-sh/bun/issues/4949

**Working workaround:**
```bash
pm2 start "bun run dist/daemon/index.js" --name routstrd --interpreter none
```

With `--interpreter none`, PM2 runs the command through the default shell (`bash -c "..."`), and `bun` executes directly. The process stays alive and logs are captured correctly.

---

### New Bug B: `import.meta.main` is False Under PM2

**Location:** `src/daemon/index.ts`

**Broken code:**
```typescript
if (import.meta.main) {
  main().catch((error) => {
    logger.error("Failed to start Routstr daemon:", error);
    process.exit(1);
  });
}
```

**Evidence:**
```bash
$ cat > dist/test-main.js << 'EOF'
console.log("import.meta.main:", import.meta.main);
console.log("import.meta.url:", import.meta.url);
EOF

$ pm2 start dist/test-main.js --name test-node --interpreter node
$ pm2 logs test-node --lines 5
0|test-node | import.meta.main: false
0|test-node | import.meta.url: file:///.../dist/test-main.js
0|test-node | argv: [
0|test-node |   '/home/user42/.local/share/nvm/v24.15.0/bin/node',
0|test-node |   '/home/user42/.bun/install/global/node_modules/pm2/lib/ProcessContainerFork.js'
0|test-node | ]
```

PM2 wraps the target script inside `ProcessContainerFork.js`. Because the script is loaded as a module by PM2's container, `import.meta.main` evaluates to **`false`**.

**Impact:** When PM2 starts the daemon with `--interpreter node` (or any interpreter that wraps the script), `main()` is **never called**. The process loads all modules, reaches the `if (import.meta.main)` guard, evaluates it as `false`, and exits cleanly with code 0. PM2 sees a clean exit and removes the process.

**Why this wasn't caught before:** The summary assumed `--interpreter bun` would be used. But `--interpreter bun` is broken (New Bug A), and the fallback/default behavior (`--interpreter node`) triggers this `import.meta.main` issue.

**Fix:** Remove the `import.meta.main` guard or add a fallback:
```typescript
// Option 1: Always run main() when loaded directly
main().catch((error) => {
  logger.error("Failed to start Routstr daemon:", error);
  process.exit(1);
});

// Option 2: Keep guard but also detect PM2 environment
if (import.meta.main || process.env.PM2_USAGE) {
  main().catch(...);
}
```

Option 1 is simpler and safer. The guard is unnecessary because `src/daemon/index.ts` is only ever the entry point.

---

## Corrected Root Cause Summary

The `service install` command fails due to a **cascade of issues**, in order of severity:

1. **PM2 `--interpreter bun` is broken** (New Bug A). The current command `pm2 start ... --interpreter bun` causes the process to exit silently within seconds.
2. **`import.meta.main` guard prevents execution** (New Bug B). If PM2 falls back to `node` or wraps the script, `main()` is never called.
3. **Path resolution is broken** (`Bun.resolveSync` with file URL). In dev mode, the fallback path points to a non-existent `.js` file, misleading users.
4. **No cocod readiness check** before spawning the daemon. If the user somehow gets past issues 1-3, an uninitialized wallet causes the daemon to crash.
5. **No `--cwd` passed to PM2**. Minor, but can cause unexpected behavior with relative paths.

---

## Reproduction Steps (Updated)

### Reproduce Bug 1 + 2 (Dev mode path failure):
```bash
bun src/index.ts service install
# Output: "Could not find daemon at .../src/daemon/index.js. Did you run 'bun run build'?"
```

### Reproduce New Bug A (PM2 `--interpreter bun` broken):
```bash
bun run build
bun dist/index.js service install
# PM2 shows "online" for 0s, then process disappears
pm2 describe routstrd
# Output: "routstrd doesn't exist"
```

### Reproduce New Bug B (`import.meta.main` false):
```bash
cat > dist/test-main.js << 'EOF'
if (import.meta.main) console.log("MAIN"); else console.log("NOT MAIN");
EOF
pm2 start dist/test-main.js --name test-main --interpreter node
pm2 logs test-main
# Output: "NOT MAIN"
```

### Reprove daemon works fine without PM2:
```bash
bun dist/daemon/index.js --port 18008
# Daemon starts, listens, bootstraps providers, stays alive
```

---

## Recommended Fixes (Updated)

### Fix 1: Change PM2 start strategy (addresses New Bug A)
Replace:
```typescript
execSync(`pm2 start "${daemonPath}" --name routstrd --interpreter bun`, ...)
```

With:
```typescript
execSync(
  `pm2 start "bun run ${daemonPath}" --name routstrd --interpreter none --cwd "${process.cwd()}"`,
  { stdio: "inherit" }
);
```

This runs `bun` directly via shell, bypassing PM2's broken `--interpreter bun` handling.

### Fix 2: Remove `import.meta.main` guard (addresses New Bug B)
In `src/daemon/index.ts`, replace:
```typescript
if (import.meta.main) {
  main().catch((error) => {
    logger.error("Failed to start Routstr daemon:", error);
    process.exit(1);
  });
}
```

With:
```typescript
main().catch((error) => {
  logger.error("Failed to start Routstr daemon:", error);
  process.exit(1);
});
```

### Fix 3: Correct path resolution (addresses Bug 1 + 2)
```typescript
const baseDir = new URL(".", import.meta.url).pathname;
let daemonPath: string;
try {
  daemonPath = Bun.resolveSync("./daemon/index.js", baseDir);
} catch (e) {
  const path = await import("path");
  daemonPath = path.join(baseDir, "daemon", "index.js");
}

// Differentiate dev vs built mode
if (!existsSync(daemonPath)) {
  // In dev, Bun resolves .js → .ts transparently, so we can try .ts
  const tsPath = daemonPath.replace(/\.js$/, ".ts");
  if (existsSync(tsPath)) {
    daemonPath = tsPath;
  }
}
```

### Fix 4: Check cocod before PM2 start (addresses Bug 3)
```typescript
const config = await loadConfig();
if (!(await isCocodInstalled(config.cocodPath))) {
  console.error("cocod is not installed or initialized. Run 'routstrd onboard' first.");
  process.exit(1);
}
```

### Fix 5: Add server error handler (prevents silent crash on port conflict)
In `src/daemon/index.ts`:
```typescript
server.on("error", (err) => {
  logger.error("Server error:", err);
  process.exit(1);
});
```

---

## Files to Modify

| File | Fixes |
|------|-------|
| `src/cli.ts` | Fix path resolution (Bug 1/2), add cocod check (Bug 3), change PM2 command (New Bug A), add `--cwd` (Bug 5) |
| `src/daemon/index.ts` | Remove `import.meta.main` guard (New Bug B), add server error handler |
