#!/usr/bin/env bun
/**
 * Cross-runtime daemon boot smoke test.
 *
 * Boots the daemon under whichever runtime is executing this file, against a
 * throwaway ROUTSTRD_DIR, and checks that every runtime-shimmed subsystem comes
 * up: the SQLite shim, the Coco wallet repositories, the SDK storage/usage
 * drivers, the persistent Nostr event store, the node:http server, and the
 * wallet PID lock (which must be released on shutdown).
 *
 * Run with:  bun scripts/smoke/daemon-boot.ts
 *            deno run -A scripts/smoke/daemon-boot.ts
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const RUNTIME = typeof (globalThis as { Deno?: unknown }).Deno !== "undefined" &&
    typeof (globalThis as { Bun?: unknown }).Bun === "undefined"
  ? "deno"
  : "bun";

const PORT = Number(process.env.SMOKE_PORT ?? 18099);
const BOOT_TIMEOUT_MS = 180_000;
const root = mkdtempSync(join(tmpdir(), "routstrd-smoke-"));
const walletDir = join(root, "wallet");
const walletPid = join(walletDir, "wallet.pid");

function log(message: string): void {
  console.log(`[smoke:${RUNTIME}] ${message}`);
}

function fail(message: string): never {
  console.error(`[smoke:${RUNTIME}] FAIL: ${message}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll<T>(label: string, timeoutMs: number, fn: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn().catch(() => null);
    if (result !== null && result !== undefined) return result;
    await sleep(500);
  }
  fail(`timed out waiting for ${label}`);
}

mkdirSync(walletDir, { recursive: true, mode: 0o700 });
mkdirSync(join(root, "cocod"), { recursive: true });
writeFileSync(
  join(walletDir, "config.json"),
  JSON.stringify(
    { version: 1, mnemonic: generateMnemonic(wordlist), encrypted: false, createdAt: new Date().toISOString() },
    null,
    2,
  ),
  { mode: 0o600 },
);

const entrypoint = new URL("../../src/daemon/index.ts", import.meta.url).pathname;
const command = RUNTIME === "deno"
  ? [process.execPath, "run", "-A", entrypoint, "--port", String(PORT)]
  : [process.execPath, entrypoint, "--port", String(PORT)];

log(`booting daemon on port ${PORT} in ${root}`);
const child = spawn(command[0]!, command.slice(1), {
  env: {
    ...process.env,
    ROUTSTRD_DIR: root,
    // Keep the smoke run away from a real ~/.cocod on the developer's machine.
    COCOD_DIR: join(root, "cocod"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout?.on("data", (chunk) => { output += chunk; });
child.stderr?.on("data", (chunk) => { output += chunk; });

let exited: number | null = null;
child.on("exit", (code) => { exited = code ?? 0; });

async function health(): Promise<Response | null> {
  if (exited !== null) fail(`daemon exited early with code ${exited}\n${output}`);
  const response = await fetch(`http://127.0.0.1:${PORT}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  return response.ok ? response : null;
}

try {
  await poll("/health", BOOT_TIMEOUT_MS, health);
  log("/health responded");

  // Proves the SQLite shim, coco repositories and SDK drivers all initialized.
  for (const file of ["routstr.db", "events.db", join("wallet", "coco.db")]) {
    if (!existsSync(join(root, file))) fail(`expected ${file} to exist after boot`);
  }
  log("sqlite databases created (routstr.db, events.db, wallet/coco.db)");

  if (!existsSync(walletPid)) fail("wallet PID lock was never claimed");
  log("wallet PID lock claimed");

  const balance = await fetch(`http://127.0.0.1:${PORT}/balance`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!balance.ok) fail(`/balance returned ${balance.status}`);
  log(`/balance responded: ${JSON.stringify(await balance.json())}`);

  const stopResponse = await fetch(`http://127.0.0.1:${PORT}/stop`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  }).then(async (r) => `${r.status} ${await r.text()}`).catch((e) => `error: ${e}`);
  log(`/stop responded: ${stopResponse}`);

  const exitDeadline = Date.now() + 60_000;
  while (exited === null && Date.now() < exitDeadline) await sleep(500);
  if (exited === null) {
    const portOpen = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) })
      .then(() => true).catch(() => false);
    fail(
      `daemon did not exit after /stop (port still accepting: ${portOpen}, ` +
        `wallet.pid present: ${existsSync(walletPid)}, child.pid: ${child.pid}, killed: ${child.killed})` +
        `\n--- daemon output ---\n${output}`,
    );
  }
  log(`daemon exited with code ${exited}`);

  // The wallet-lock race fix depends on this file going away on clean shutdown.
  if (existsSync(walletPid)) fail("wallet PID lock was not released on shutdown");
  log("wallet PID lock released");

  log("PASS");
} finally {
  if (exited === null) child.kill("SIGKILL");
  if (!process.env.SMOKE_KEEP) rmSync(root, { recursive: true, force: true });
  else log(`kept ${root}`);
}
