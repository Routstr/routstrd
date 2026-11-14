import { IncrementalRequestLogs } from "./utils/incremental-request-logs";
import { normalizeOfflineSweepMintUrl } from "./daemon/wallet/offline-sweep";
import { loadRequestTraces, RequestLogFollower, utcTime, type RequestLogFilters } from "./utils/request-logs";
import { program } from "commander";
import { startDaemon } from "./start-daemon";
import { ensureDirsSync, saveDaemonConfig } from "./daemon/config-store";
import {
  handleDaemonCommand,
  callDaemon,
  callAuth,
  DaemonHttpError,
  ensureDaemonRunning,
  isDaemonRunning,
  loadConfig,
  getDaemonBaseUrl,
  getUserNpub,
  normalizeBaseUrl,
  type CommandResponse,
} from "./utils/daemon-client";
import {
  formatCooldowns,
  formatCooldownsReset,
  type CooldownsOutput,
  type CooldownsResetOutput,
} from "./utils/cooldowns";
import {
  formatModelPaths,
  type ModelPathsOutput,
} from "./utils/model-paths";
import {
  formatModelProviders,
  type ModelWithProviders,
} from "./utils/model-providers";
import {
  formatProviderList,
  type ProviderListOutput,
} from "./utils/provider-reachability";
import { waitForDaemonToExit } from "./utils/daemon-stop";
import {
  listClientsAction,
  deleteClientAction,
  addClientAction,
  refreshModelsAndClientsAction,
  setAutomaticRefreshAction,
} from "./utils/clients";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import {
  CONFIG_DIR,
  DB_PATH,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  LOGS_DIR,
  type RoutstrdConfig,
} from "./utils/config";
import { COCO_LOGS_DIR, logger } from "./utils/logger";
import { setupIntegration, type IntegrationKey } from "./integrations";
import {
  assertLegacyCocodNotRunning,
  claimLegacyCocodPidFile,
  stopLegacyCocod,
} from "./daemon/wallet/coco-client";
import { migrateLegacyWallet } from "./daemon/wallet/migration";
import {
  diagnoseWallets,
  renderWalletDoctor,
  summarizeWalletDirectory,
  WalletMigrationConflictError,
} from "./daemon/wallet/diagnostics";
import {
  legacyCocodDir,
  legacyCocodPidPath,
  legacyCocodSocketPath,
  walletDir as defaultWalletDir,
  walletPidPath,
} from "./daemon/wallet/paths";
import * as QRCode from "qrcode";
import { normalizeNostrPubkey, npubFromPubkey, npubFromSecretKey } from "./utils/nip98";
import { parseRequiredNpubName, parseUpdatedNpubName } from "./utils/npub-name";
import { formatOwnNpub } from "./utils/own-npub";
import {
  HISTORY_ENTRY_TYPES,
  historyStatus,
  isHistoryEntryType,
} from "./utils/history";
import { generateSecretKey, nip19 } from "nostr-tools";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  checkRoutstrdUpdate,
  compareVersions,
  getGlobalPackageVersion,
  getLatestNpmVersion,
} from "./utils/update-checker.ts";
import { isStandaloneExecutable, pm2DaemonArgs } from "./runtime";
import { VERSION } from "./version";
import {
  isUpdateStateApplicable,
  readUpdateState,
  updateNotice,
  writeUpdateState,
} from "./utils/update-state";
import {
  getLatestStandaloneRelease,
  installStandaloneRelease,
} from "./utils/standalone-update";

type RoutstrModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
};

type UsageEntry = {
  id: string;
  timestamp: number;
  modelId: string;
  baseUrl: string;
  requestId: string;
  cost: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  client?: string;
};

function parsePositiveIntOrExit(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid ${fieldName}: ${value}`);
    process.exit(1);
  }
  return parsed;
}

function isPositiveIntegerString(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

/** `--overpay-cap` with no value means the 3x default. */
function parseOverpayCapOrExit(
  value: string | boolean | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const factor = value === true ? 3 : Number(value);
  if (!Number.isFinite(factor) || factor < 1) {
    console.error(`Invalid --overpay-cap: ${String(value)} (expected a number >= 1)`);
    process.exit(1);
  }
  return factor;
}

async function printLightningInvoice(invoice: string): Promise<void> {
  const paymentUri = `lightning:${invoice}`;
  const qr = await QRCode.toString(paymentUri, {
    type: "terminal",
    small: true,
  });

  console.log(`${qr}\nInvoice:\n${invoice}`);
}

/** Block until the daemon has minted the paid invoice, then show the credit. */
async function waitForMintQuote(operationId: string): Promise<void> {
  console.log(
    "\nWaiting for payment... (Ctrl+C stops waiting; the daemon keeps checking)",
  );
  for (;;) {
    const result = await callDaemon(
      `/wallet/receive/bolt11/${encodeURIComponent(operationId)}`,
    );
    const quote = result.output as
      | { state?: string; amount?: number; error?: string }
      | undefined;
    if (quote?.state === "finalized" && quote.error) {
      // The mint issued the quote but the wallet could not restore the proofs.
      console.error(`Payment reached the mint but could not be credited: ${quote.error}`);
      process.exit(1);
    }
    if (quote?.state === "finalized") {
      const balance = await callDaemon("/wallet/balance");
      const balances =
        (balance.output as { balances?: Record<string, number> } | undefined)
          ?.balances ?? {};
      const total = Object.values(balances).reduce((sum, sats) => sum + sats, 0);
      console.log(`Received ${quote.amount} sat. Balance: ${total} sat`);
      return;
    }
    if (quote?.state === "failed") {
      console.error(`Invoice failed: ${quote.error ?? "unknown reason"}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Warn that value-moving wallet operations will block until startup recovery
 * finishes. Reads stay available, but the daemon gates send/receive behind the
 * recovery gate, so without this notice the CLI would appear to hang silently
 * after a restart.
 */
async function warnIfWalletRecovering(): Promise<void> {
  try {
    await ensureDaemonRunning();
    const result = await callDaemon("/wallet/status");
    const output = result.output as
      | { state?: string; recovery?: { phase?: string } }
      | undefined;
    if (output?.state !== "RECOVERING") return;

    const phase = output.recovery?.phase;
    console.error(
      "Wallet is recovering from a previous run (this only happens after a restart).",
    );
    if (phase && phase !== "done") {
      console.error(`Recovery phase: ${phase}.`);
    }
    console.error(
      "Please wait — send and receive resume as soon as recovery completes.",
    );
  } catch {
    // Status is best-effort; never block the real command on it.
  }
}

export function initializeWallet(walletDir = defaultWalletDir()): void {
  const walletConfig = join(walletDir, "config.json");

  // The wallet directory and config contain the plaintext seed phrase. Correct
  // permissions on existing installations as well as newly created ones.
  mkdirSync(walletDir, { recursive: true, mode: 0o700 });
  chmodSync(walletDir, 0o700);

  if (existsSync(walletConfig)) {
    chmodSync(walletConfig, 0o600);
    console.log("Wallet already initialized.");
    return;
  }

  const mnemonic = generateMnemonic(wordlist);
  const config = {
    version: 1,
    mnemonic,
    encrypted: false,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(walletConfig, JSON.stringify(config, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  console.log("Initialized. Mnemonic:", mnemonic);
  console.log("IMPORTANT: Write down this mnemonic and keep it safe!");
}

type PidFileDeps = {
  readFile(path: string): string;
  isProcessRunning(pid: number): boolean;
};

export function getLivePidFileOwner(
  path: string,
  deps: PidFileDeps = {
    readFile: (pidPath) => readFileSync(pidPath, "utf8"),
    isProcessRunning: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  },
): number | null {
  try {
    const contents = deps.readFile(path).trim();
    if (!/^\d+$/.test(contents)) return null;
    const pid = Number.parseInt(contents, 10);
    return pid > 0 && deps.isProcessRunning(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Restart the routstrd daemon after an update so the new binary takes
 * effect immediately. Failures are collected and reported but never
 * roll back the update itself.
 *
 * Returns false when a daemon could not be restarted (callers decide whether
 * that is fatal).
 *
 * Note: cocod is no longer a separate process — the wallet now runs
 * in-process via coco-core, so there is nothing else to restart.
 */
async function restartDaemonsAfterUpdate(): Promise<boolean> {
  const config = await loadConfig();
  const isRemote = !!config.daemonUrl;
  const failures: string[] = [];

  // --- routstrd daemon ---
  if (isRemote) {
    console.log("\nUsing remote daemon — skipping routstrd daemon restart.");
  } else {
    try {
      const wasRunning = await isDaemonRunning();
      if (!wasRunning) {
        console.log("\nroutstrd daemon was not running — skipping restart.");
      } else {
        const pidFilePath = walletPidPath();
        const ownerPid = getLivePidFileOwner(pidFilePath);
        if (ownerPid === null) {
          throw new Error(
            `Refusing to stop the process at ${getDaemonBaseUrl(config)} because ` +
              `no live routstrd owner was found in ${pidFilePath}`,
          );
        }

        console.log(`\nRestarting routstrd daemon (PID: ${ownerPid})...`);
        await callDaemon("/stop", { method: "POST" });

        // Wait for the old daemon to fully exit: it keeps serving ongoing
        // requests before it releases the wallet lock and the new daemon can
        // safely claim it.
        await waitForDaemonToExit({ pidFilePath });
        console.log("routstrd daemon stopped.");

        await stopLegacyCocod();

        console.log("Starting routstrd daemon...");
        await startDaemon({
          port: String(config.port || 8008),
          host: config.host || undefined,
          provider: config.provider || undefined,
        });
        console.log("routstrd daemon restarted.");
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push(`routstrd daemon: ${msg}`);
    }
  }

  // --- report ---
  if (failures.length > 0) {
    console.error("\n⚠ Failed to restart daemon:");
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    console.error(
      "The update was applied but may not take effect until the daemon is manually restarted.",
    );
    return false;
  }

  console.log("\n✓ Daemon restarted successfully.");
  return true;
}

/**
 * Install the newest routstrd, whichever way it was installed: standalone
 * binaries are replaced in place from the GitHub Release, and npm/bun installs
 * are upgraded through the package manager.
 *
 * Returns true when a newer version was installed, false when already current.
 * Throws when the install itself fails so callers can decide what to do.
 */
async function applyRoutstrdUpdate(): Promise<boolean> {
  if (isStandaloneExecutable()) {
    const release = await getLatestStandaloneRelease();
    if ((compareVersions(VERSION, release.version) ?? -1) >= 0) {
      console.log(`routstrd is already up to date (v${VERSION}).`);
      return false;
    }

    console.log(`Updating routstrd from v${VERSION} to v${release.version}...`);
    await installStandaloneRelease(release);
    console.log("routstrd updated successfully.\n");
    recordUpdateApplied(release.version);
    return true;
  }

  const installed = await getGlobalPackageVersion("routstrd");
  const latest = await getLatestNpmVersion("routstrd");

  // Only skip when we're confident the installed version is current.
  // If we can't determine either version we fall through to installing.
  if (
    installed &&
    latest &&
    (compareVersions(installed, latest) ?? -1) >= 0
  ) {
    console.log(`routstrd is already up to date (v${installed}).`);
    return false;
  }

  const fromPart = installed ? ` from v${installed}` : "";
  const toPart = latest ? ` to v${latest}` : "";
  console.log(`Updating routstrd${fromPart}${toPart}...`);

  const proc = Bun.spawn(["bun", "install", "-g", "routstrd"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await proc.exited) !== 0) {
    throw new Error("Failed to update routstrd.");
  }
  console.log("routstrd updated successfully.\n");
  recordUpdateApplied(latest);
  return true;
}

/**
 * Clear the cached "update available" state right after we install one, so the
 * CLI notice stops nagging before the daemon's next scheduled check catches up.
 * Best-effort: a stale cache only costs one extra notice.
 */
function recordUpdateApplied(newVersion: string | null): void {
  try {
    writeUpdateState({
      current: newVersion ?? VERSION,
      latest: newVersion,
      hasUpdate: false,
      checkedAt: new Date().toISOString(),
    });
  } catch {
    // Ignore — the daemon will refresh the state on its own schedule.
  }
}

/**
 * Ask whether to install an available update. Yes is the default: an empty
 * answer (bare Enter) is treated as yes.
 */
async function confirmUpdate(current: string, latest: string): Promise<boolean> {
  const rl = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      let settled = false;
      const done = (value: string) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      rl.question(
        `A new routstrd version is available (v${current} -> v${latest}). Update now? [Y/n] `,
        (value: string) => done(value.trim().toLowerCase()),
      );
      // Ctrl+D / EOF closes the interface without answering; treat as "no".
      rl.once("close", () => done("n"));
    });
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Offer to update routstrd before the daemon starts. Interactive only: piped
 * and CI/PM2 invocations skip the check entirely so scripts never block on a
 * prompt or pay for a network round-trip. Update failures are reported but
 * never stop the daemon from starting.
 *
 * Returns true only when an update was actually installed, so callers can
 * restart the daemon so the new build takes effect.
 *
 * Set updateCheck: false in config.json to opt out even on a terminal.
 */
async function maybePromptForUpdate(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if ((await loadConfig()).updateCheck === false) return false;

  let info;
  try {
    info = await checkRoutstrdUpdate();
  } catch {
    return false; // Update checks are best-effort.
  }
  if (!info.hasUpdate || !info.latest) return false;

  if (!(await confirmUpdate(info.current, info.latest))) {
    console.log("Skipping update.\n");
    return false;
  }

  try {
    await applyRoutstrdUpdate();
    return true;
  } catch (error) {
    console.error(
      `\n⚠ Could not update routstrd: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("Continuing with the current version.\n");
    return false;
  }
}

let updateNoticeShown = false;

/**
 * Print a one-line "update available" notice for commands that don't manage
 * updates themselves (balance, send, receive, ...). It reads the daemon's
 * cached background check from disk — no network call — so it is cheap enough
 * to run after every command, and it writes to stderr so stdout stays clean
 * for piping/JSON. At most one notice per process.
 */
async function maybeShowUpdateNotice(): Promise<void> {
  if (updateNoticeShown) return;
  if ((await loadConfig()).updateCheck === false) return;

  const state = readUpdateState();
  if (!state || !isUpdateStateApplicable(state, VERSION)) return;

  const notice = updateNotice(state);
  if (!notice) return;

  updateNoticeShown = true;
  console.error(`\n${notice}`);
}

async function requireLocalDaemon(): Promise<void> {
  const config = await loadConfig();
  if (config.daemonUrl) {
    console.error(
      `This command is not available when using a remote daemon (${config.daemonUrl}).`,
    );
    process.exit(1);
  }
}

/**
 * Stop the local daemon (when it is running), wait for it to release the wallet
 * lock, then start it again. Startup-only settings (mode) use this so a
 * persisted change takes effect immediately.
 */
async function restartLocalDaemon(
  config: RoutstrdConfig,
  options: { port?: string; host?: string; provider?: string } = {},
): Promise<void> {
  if (await isDaemonRunning()) {
    console.log("Stopping daemon...");
    await callDaemon("/stop", { method: "POST" });

    // Wait for the old daemon to fully exit: it keeps serving ongoing requests
    // before it releases the wallet lock the new daemon has to claim.
    try {
      await waitForDaemonToExit({ pidFilePath: walletPidPath() });
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    console.log("Daemon stopped.");
  } else {
    console.log("Daemon was not running.");
  }

  await stopLegacyCocod();

  console.log("Starting daemon...");
  await startDaemon({
    port: options.port || String(config.port || 8008),
    host: options.host || config.host || undefined,
    provider: options.provider || config.provider || undefined,
  });
}

export type AutoModelPathStatus = {
  /** Value routing uses right now. For a stopped daemon this is the configured one. */
  autoModelPath: boolean;
  /** Value persisted in config.json, used the next time the daemon starts. */
  configured: boolean;
  /** False when the values above come from config.json because nothing answered. */
  running: boolean;
};

/**
 * Read the auto model path setting.
 *
 * A running daemon is authoritative for the live value — the CLI cannot read
 * another process's memory, so it asks. When no daemon answers, fall back to
 * config.json rather than booting a wallet-bearing daemon just to print a
 * boolean; the caller reports which of the two it got.
 *
 * The request doubles as the version probe: a daemon built before the endpoint
 * existed answers 404, or the "only POST is supported" catch-all 405.
 */
async function fetchAutoModelPathStatus(): Promise<AutoModelPathStatus> {
  const config = await loadConfig();

  if (!(await isDaemonRunning())) {
    if (config.daemonUrl) {
      console.error(`Daemon is not reachable at ${config.daemonUrl}.`);
      process.exit(1);
    }
    const configured = config.autoModelPath === true;
    return { autoModelPath: configured, configured, running: false };
  }

  let result: CommandResponse;
  try {
    result = await callDaemon("/settings/auto-model-path");
  } catch (error) {
    if (
      error instanceof DaemonHttpError &&
      (error.status === 404 || error.status === 405)
    ) {
      console.error(
        "The running daemon has no /settings/auto-model-path endpoint, so it cannot read this setting. " +
          "Update it (routstrd update) and restart it (routstrd restart), then try again.",
      );
      process.exit(1);
    }
    throw error;
  }

  if (result.error) {
    console.log(result.error);
    process.exit(1);
  }

  const output = result.output as
    | { autoModelPath?: unknown; configured?: unknown }
    | undefined;
  if (
    typeof output?.autoModelPath !== "boolean" ||
    typeof output.configured !== "boolean"
  ) {
    console.error(
      "The running daemon returned an unexpected /settings/auto-model-path payload. " +
        "Update it (routstrd update) and try again.",
    );
    process.exit(1);
  }

  return {
    autoModelPath: output.autoModelPath,
    configured: output.configured,
    running: true,
  };
}

/**
 * Render the status lines for `routstrd models auto-model-path`. Kept separate
 * from the action so the configured-versus-live distinction is unit tested.
 */
export function formatAutoModelPathStatus(
  status: AutoModelPathStatus,
): string[] {
  const state = (enabled: boolean) => (enabled ? "enabled" : "disabled");
  const lines = [
    `Automatic model-path selection: ${state(status.autoModelPath)}` +
      (status.running ? "" : " (configured; the daemon is not running)"),
  ];

  // Only a hand-edited config.json can disagree with a running daemon now: a
  // change through this command is applied to routing immediately.
  if (status.running && status.configured !== status.autoModelPath) {
    lines.push(
      `config.json says ${state(status.configured)} — restart the daemon (routstrd restart) to apply the file value.`,
    );
  }

  return lines;
}

export type AutoModelPathArg =
  | { kind: "status" }
  | { kind: "set"; enabled: boolean }
  | { kind: "toggle" }
  | { kind: "invalid"; value: string };

/**
 * Parse the optional `[state]` argument of `routstrd models auto-model-path`.
 * Missing or `status` reports the current setting; `on`/`off` set it explicitly
 * and `toggle` flips it.
 */
export function parseAutoModelPathArg(
  raw: string | undefined,
): AutoModelPathArg {
  if (raw === undefined) return { kind: "status" };

  switch (raw.trim().toLowerCase()) {
    case "":
    case "status":
      return { kind: "status" };
    case "on":
    case "enable":
    case "enabled":
    case "true":
      return { kind: "set", enabled: true };
    case "off":
    case "disable":
    case "disabled":
    case "false":
      return { kind: "set", enabled: false };
    case "toggle":
      return { kind: "toggle" };
    default:
      return { kind: "invalid", value: raw };
  }
}

async function initDaemon(integrationKey?: IntegrationKey): Promise<void> {
  console.log("Initializing routstrd...");

  // Create config directory (0700, correcting existing installs too)
  if (!existsSync(CONFIG_DIR)) {
    console.log(`Created config directory: ${CONFIG_DIR}`);
  }
  ensureDirsSync();

  // Create initial config (0600, atomic write)
  if (!existsSync(CONFIG_FILE)) {
    const config: RoutstrdConfig = { ...DEFAULT_CONFIG };
    saveDaemonConfig(config);
    console.log(`Created config file: ${CONFIG_FILE}`);
  }

  const config = await loadConfig();

  if (!config.nsec) {
    const secretKey = generateSecretKey();
    const nsec = nip19.nsecEncode(secretKey);
    const npub = npubFromSecretKey(secretKey);
    config.nsec = nsec;
    saveDaemonConfig(config);
    console.log("\nA new Nostr identity has been generated for authentication.");
    console.log(`Your npub: ${npub}`);
    console.log(`You can view it in the config file at: ${CONFIG_FILE}\n`);
  }

  console.log(`Database will be stored at: ${DB_PATH}`);
  await stopLegacyCocod();

  const migration = await migrateLegacyWallet({
    assertLegacyStopped: () =>
      assertLegacyCocodNotRunning({
        socketPath: legacyCocodSocketPath(),
      }),
    acquireLegacyLock: () => {
      mkdirSync(dirname(legacyCocodPidPath()), {
        recursive: true,
        mode: 0o700,
      });
      return claimLegacyCocodPidFile({
        pidFilePath: legacyCocodPidPath(),
      });
    },
  });
  if (migration.status === "migrated") {
    console.log(`Migrated wallet from ${migration.from} to ${migration.to}.`);
    for (const warning of migration.cleanupWarnings) console.warn(warning);
  }
  initializeWallet();

  await startDaemon({ port: String(config.port || 8008), host: config.host || undefined });

  await setupIntegration(config, integrationKey);

  console.log("\nInitialization complete!");
  console.log(
    "\n use 'routstrd receive <cashu-token>' or 'routstrd receive 2100' to top up your local wallet using Lightning!",
  );
  console.log(
    "\n full wallet commands still work too, e.g. 'routstrd wallet receive cashu <token>' and 'routstrd wallet receive bolt11 2100'.",
  );
  console.log(
    "\nTo ensure routstrd persists across system restarts, run: 'routstrd service install'",
  );
}

program
  .name("routstrd")
  .description("Routstr daemon - Manage routstr processes")
  .version(VERSION, "--version", "output the version number");

program
  .command("update")
  .description("Update routstrd to the latest version")
  .action(async () => {
    let updatedAny: boolean;
    try {
      updatedAny = await applyRoutstrdUpdate();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    if (updatedAny) {
      console.log("All requested updates have been applied!");
      // Restart daemons so the new binaries take effect immediately.
      const restarted = await restartDaemonsAfterUpdate();
      if (!restarted) process.exit(1);
    }
  });

/**
 * Tokens the daemon had parked after a failed receive and retried as part of
 * this refund. Reported separately because they never appear in the store's
 * pending token/API key counts — without this line a refund that recovered
 * them looks identical to one that had nothing to do.
 */
interface RefundRecovery {
  attempted: number;
  succeeded: number;
  error?: string;
}

function printRecoveredTokens(recovered?: RefundRecovery): void {
  if (!recovered || (recovered.attempted === 0 && !recovered.error)) return;
  if (recovered.error) {
    console.log(`\nParked tokens: recovery failed: ${recovered.error}`);
    return;
  }
  const stillParked = recovered.attempted - recovered.succeeded;
  console.log(
    `\nParked tokens: ${recovered.succeeded}/${recovered.attempted} received` +
      (stillParked > 0
        ? `, ${stillParked} still parked (the daemon retries them every 42 minutes)`
        : ""),
  );
}

program
  .command("refund")
  .description("Refund pending tokens and API keys to a specified mint")
  .option(
    "-m, --mint-url <mintUrl>",
    "Mint URL to refund to (defaults to active wallet mint)",
  )
  .option("-y, --yes", "Skip confirmation prompt", false)
  .option("--xcashu", "Refund xcashu tokens only (uses refundXcashuTokens)", false)
  .action(async (options: { mintUrl?: string; yes: boolean; xcashu: boolean }) => {
    await ensureDaemonRunning();

    let mintUrl = options.mintUrl;
    if (!mintUrl) {
      const balanceResult = await callDaemon("/balance");
      if (balanceResult.error) {
        console.log(balanceResult.error);
        process.exit(1);
      }
      const output = balanceResult.output as
        | {
            balances?: Record<string, number>;
            activeMint?: string;
          }
        | undefined;
      mintUrl =
        output?.activeMint ??
        (output?.balances ? Object.keys(output.balances)[0] : undefined);
      if (!mintUrl) {
        console.log("No mint URLs found in wallet balance");
        process.exit(1);
      }
      console.log(`Using mint URL: ${mintUrl}`);
    }

    try {
      if (options.xcashu) {
        // xcashu path: only refund xcashu tokens
        const result = await callDaemon("/refund/xcashu", {
          method: "POST",
          body: { mintUrl },
        });

        if (result.error) {
          console.log(result.error);
          process.exit(1);
        }

        const output = result.output as
          | {
              message: string;
              recovered?: RefundRecovery;
              results: Array<{ baseUrl: string; token: string; success: boolean; error?: string }>;
            }
          | undefined;

        if (output) {
          console.log(output.message);
          printRecoveredTokens(output.recovered);
          console.log("\nResults:");
          for (const r of output.results) {
            const status = r.success ? "success" : `failed: ${r.error || "unknown"}`;
            console.log(`  - ${r.baseUrl}: ${status}`);
          }
        }
        return;
      }

      const result = await callDaemon("/refund", {
        method: "POST",
        body: { mintUrl },
      });

      if (result.error) {
        console.log(result.error);
        process.exit(1);
      }

      const output = result.output as
        | {
            message: string;
            pendingTokens: number;
            apiKeys: number;
            recovered?: RefundRecovery;
            results: Array<{ baseUrl: string; success: boolean }>;
          }
        | undefined;

      if (output) {
        console.log(output.message);
        console.log(`\nPending tokens: ${output.pendingTokens}`);
        console.log(`API keys: ${output.apiKeys}`);
        printRecoveredTokens(output.recovered);
        console.log("\nResults:");
        for (const r of output.results) {
          console.log(`  - ${r.baseUrl}: ${r.success ? "success" : "failed"}`);
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      if (
        message?.includes("fetch failed") ||
        message?.includes("Connection refused")
      ) {
        console.error("Daemon is not running");
        process.exit(1);
      }
      console.error(message);
      process.exit(1);
    }
  });

// Remote - show or configure a remote daemon URL
program
  .command("remote [url]")
  .description(
    "Show the configured remote daemon, or configure one. With no URL, prints the current remote node; pass a URL to set one up.",
  )
  .option("--auth-url <authUrl>", "URL of the auth proxy for management commands (npubs, clients, usage)")
  .action(async (url: string | undefined, options: { authUrl?: string }) => {
    const config = await loadConfig();

    // No URL provided -> show the current remote node, or tell the user to set one up.
    if (!url) {
      if (config.daemonUrl) {
        console.log(`Remote daemon URL: ${config.daemonUrl}`);
        if (config.authUrl) {
          console.log(`Auth proxy URL: ${config.authUrl}`);
        }
        const npub = getUserNpub(config);
        if (npub) {
          console.log(`Nostr identity: ${npub}`);
        }
        return;
      }
      console.error("No remote node is set up.");
      const npubLine = formatOwnNpub(config);
      if (npubLine) console.error(npubLine);
      console.error(
        "Pass a URL to set one up, e.g. 'routstrd remote https://<host>:<port>'.",
      );
      process.exit(1);
    }

    try {
      new URL(normalizeBaseUrl(url));
    } catch {
      console.error(`Invalid URL: ${url}`);
      process.exit(1);
    }

    if (options.authUrl) {
      try {
        new URL(normalizeBaseUrl(options.authUrl));
      } catch {
        console.error(`Invalid auth URL: ${options.authUrl}`);
        process.exit(1);
      }
    }

    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    const normalizedUrl = normalizeBaseUrl(url);
    const updates: Partial<RoutstrdConfig> = { daemonUrl: normalizedUrl };
    if (options.authUrl) {
      updates.authUrl = normalizeBaseUrl(options.authUrl);
    }
    let generatedNpub: string | undefined;

    if (!config.nsec) {
      const secretKey = generateSecretKey();
      const nsec = nip19.nsecEncode(secretKey);
      const npub = npubFromSecretKey(secretKey);
      updates.nsec = nsec;
      generatedNpub = npub;
    }

    const updatedConfig: RoutstrdConfig = {
      ...config,
      ...updates,
    };

    saveDaemonConfig(updatedConfig);

    console.log(`Remote daemon URL set to: ${normalizedUrl}`);
    if (options.authUrl) {
      console.log(`Auth proxy URL set to: ${normalizeBaseUrl(options.authUrl)}`);
    }
    if (generatedNpub) {
      console.log(
        `\nA new Nostr identity has been generated for remote authentication.`,
      );
      console.log(`Your npub: ${generatedNpub}`);
      console.log(
        `You can view it in the config file at: ${CONFIG_FILE}`,
      );
    }
  });

// Local - switch back to local daemon mode (removes daemonUrl/authUrl)
program
  .command("local")
  .description("Switch back to local daemon mode (removes remote daemon URL)")
  .action(async () => {
    const config = await loadConfig();

    if (!config.daemonUrl) {
      console.log("Already in local mode — no remote daemon URL is configured.");
      return;
    }

    const previousDaemonUrl = config.daemonUrl;
    const previousAuthUrl = config.authUrl;

    const { daemonUrl: _daemonUrl, authUrl: _authUrl, ...rest } = config;
    const updatedConfig: RoutstrdConfig = rest;

    saveDaemonConfig(updatedConfig);

    console.log("Switched back to local daemon mode.");
    if (previousDaemonUrl) {
      console.log(`  Removed remote daemon URL: ${previousDaemonUrl}`);
    }
    if (previousAuthUrl) {
      console.log(`  Removed auth proxy URL: ${previousAuthUrl}`);
    }
    console.log(
      `\nUse 'routstrd onboard' for first time using local mode or 'routstrd start' to start the local daemon if you already are using it.`,
    );
    console.log(`You can view the config file at: ${CONFIG_FILE}`);
  });

// Onboard - initialize the daemon
program
  .command("onboard")
  .description(
    "Initialize routstrd (creates config directory and initializes wallet)",
  )
  .option("--opencode", "Set up OpenCode integration (non-interactive)")
  .option("--openclaw", "Set up OpenClaw integration (non-interactive)")
  .option("--pi-agent", "Set up Pi Agent integration (non-interactive)")
  .option("--claude-code", "Set up Claude Code integration (non-interactive)")
  .option("--hermes", "Set up Hermes integration (non-interactive)")
  .option("--skip-integration", "Skip integration setup")
  .action(
    async (options: {
      opencode?: boolean;
      openclaw?: boolean;
      piAgent?: boolean;
      claudeCode?: boolean;
      hermes?: boolean;
      skipIntegration?: boolean;
    }) => {
      await requireLocalDaemon();

      const integrationFlags: Record<string, boolean | undefined> = {
        opencode: options.opencode,
        openclaw: options.openclaw,
        "pi-agent": options.piAgent,
        "claude-code": options.claudeCode,
        hermes: options.hermes,
      };
      const selectedIntegrations = Object.keys(integrationFlags).filter(
        (key) => integrationFlags[key],
      );

      if (selectedIntegrations.length > 1) {
        console.error(
          "Error: use only one integration flag, or use 'routstrd clients add' for multiple clients.",
        );
        process.exit(1);
      }

      if (options.skipIntegration && selectedIntegrations.length > 0) {
        console.error(
          "Error: --skip-integration cannot be combined with an integration flag.",
        );
        process.exit(1);
      }

      let integrationKey: IntegrationKey | undefined;
      if (options.skipIntegration) {
        integrationKey = "skip";
      } else if (selectedIntegrations.length === 1) {
        integrationKey = selectedIntegrations[0];
      }

      try {
        await initDaemon(integrationKey);
      } catch (error) {
        // An expected, user-actionable refusal — print the structured message
        // without Bun's unhandled-rejection source snippet and stack trace.
        if (error instanceof WalletMigrationConflictError) {
          console.error(error.message);
          process.exit(1);
        }
        throw error;
      }
    },
  );

program
  .command("daemon")
  .description("Run the daemon in the foreground")
  .option("--port <port>", "Port to listen on")
  .option("--host <host>", "Bind address")
  .option("-p, --provider <provider>", "Default provider to use")
  .action(async (options: { port?: string; host?: string; provider?: string }) => {
    await requireLocalDaemon();
    const argv = ["routstrd", "daemon"];
    if (options.port) argv.push("--port", options.port);
    if (options.host) argv.push("--host", options.host);
    if (options.provider) argv.push("--provider", options.provider);
    const { runDaemon } = await import("./daemon/index");
    await runDaemon(argv);
  });

// Start - start the background daemon
program
  .command("start")
  .description("Start the background daemon")
  .option("--port <port>", "Port to listen on")
  .option("--host <host>", "Bind address (default: 127.0.0.1)")
  .option("-p, --provider <provider>", "Default provider to use")
  .action(async (options: { port?: string; host?: string; provider?: string }) => {
    await requireLocalDaemon();
    // If an update was installed, restart the running daemon so the new build
    // takes effect; otherwise startDaemon would no-op on the old process.
    if (await maybePromptForUpdate()) {
      await restartDaemonsAfterUpdate();
    }
    const config = await loadConfig();
    await stopLegacyCocod();
    try {
      await startDaemon({
        port: options.port || String(config.port || 8008),
        host: options.host || config.host || undefined,
        provider: options.provider,
      });
    } catch (error) {
      // startDaemon embeds the failed daemon's own output in the message
      // (including the wallet-conflict report), so print it without a stack.
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Status - check daemon status
program
  .command("status")
  .description("Check daemon and wallet status")
  .action(async () => {
    const running = await isDaemonRunning();
    if (!running) {
      console.log("Daemon is not running");
      process.exit(1);
    }

    const result = await callDaemon("/status");
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    if (result.output !== undefined) {
      if (typeof result.output === "string") {
        console.log(result.output);
      } else {
        try {
          const formatted = JSON.stringify(result.output, null, 2);
          console.log(formatted ?? String(result.output));
        } catch {
          console.log(String(result.output));
        }
      }
    }
  });

// Balance - get wallet and API key balances
program
  .command("balance")
  .description("Get wallet and API key balances")
  .option("--api-keys", "List all stored API keys (baseUrl + key + balance)", false)
  .option(
    "--delete-api-keys <baseUrl>",
    "Delete the API key stored for the given provider base URL (refunds balance first)",
  )
  .option(
    "--mint-url <url>",
    "Mint URL to refund the deleted API key balance to (defaults to active wallet mint)",
  )
  .action(async (options: { apiKeys: boolean; deleteApiKeys?: string; mintUrl?: string }) => {
    await ensureDaemonRunning();

    if (options.deleteApiKeys) {
      const baseUrl = options.deleteApiKeys;
      const queryParts = [`baseUrl=${encodeURIComponent(baseUrl)}`];
      if (options.mintUrl) {
        queryParts.push(`mintUrl=${encodeURIComponent(options.mintUrl)}`);
      }
      const result = await callDaemon(
        `/keys/api/delete?${queryParts.join("&")}`,
        { method: "DELETE" },
      );
      if (result.error) {
        console.log(result.error);
        process.exit(1);
      }
      const out = result.output as
        | {
            baseUrl?: string;
            removed?: boolean;
            refunded?: boolean;
            refundedAmount?: number;
            refundMessage?: string;
            message?: string;
          }
        | undefined;
      if (out) {
        console.log(out.message ?? `Removed API key for ${baseUrl}`);
        if (out.refunded && out.refundedAmount !== undefined) {
          console.log(`  Refunded: ${out.refundedAmount} sats`);
        } else if (out.refundMessage) {
          console.log(`  Refund: ${out.refundMessage}`);
        }
      }
      return;
    }

    if (options.apiKeys) {
      const result = await callDaemon("/keys/api");
      if (result.error) {
        console.log(result.error);
        process.exit(1);
      }

      const data = result.output as
        | {
            apiKeys: Array<{
              baseUrl: string;
              key: string;
              balance: number;
              lastUsed: number | null;
            }>;
            count: number;
            total: number;
            unit: string;
          }
        | undefined;

      console.log("=== API Keys ===\n");
      if (!data || data.apiKeys.length === 0) {
        console.log("  No API keys stored.");
        return;
      }
      for (const k of data.apiKeys) {
        const lastUsed = k.lastUsed
          ? new Date(k.lastUsed).toISOString()
          : "never";
        console.log(`  ${k.baseUrl}`);
        console.log(`    key:      ${k.key}`);
        console.log(`    balance:  ${k.balance} ${data.unit}`);
        console.log(`    lastUsed: ${lastUsed}`);
        console.log("");
      }
      console.log(`  Total: ${data.apiKeys.length} key(s), ${data.total} ${data.unit}`);
      return;
    }

    const [walletResult, keysResult] = await Promise.all([
      callDaemon("/balance"),
      callDaemon("/keys/balance"),
    ]);

    console.log("Checking full system balance...\n");

    console.log("=== Wallet Balance ===");
    let totalWallet = 0;
    if (
      walletResult.output &&
      typeof walletResult.output === "object" &&
      "balances" in walletResult.output
    ) {
      const balances = (
        walletResult.output as { balances: Record<string, number> }
      ).balances;
      for (const [mintUrl, balance] of Object.entries(balances)) {
        console.log(`  ${mintUrl}: ${balance} sats`);
        totalWallet += balance;
      }
      console.log(`  Total: ${totalWallet} sats`);
    } else if (walletResult.error) {
      console.error("Wallet error:", walletResult.error);
    }

    console.log("\n=== API Keys ===");
    let totalApiKeys = 0;
    if (
      keysResult.output &&
      typeof keysResult.output === "object" &&
      "keys" in keysResult.output
    ) {
      const keys = (
        keysResult.output as {
          keys: Array<{ id: string; name: string; balance: number }>;
        }
      ).keys;
      const apiKeyEntries = keys.filter((k) => k.id.startsWith("apikey:"));
      for (const key of apiKeyEntries) {
        const name = key.name.replace("API Key: ", "");
        console.log(`  ${name}: ${key.balance} sats`);
        totalApiKeys += key.balance;
      }
      if (apiKeyEntries.length === 0) {
        console.log("  No API keys found");
      } else {
        console.log(`  Total: ${totalApiKeys} sats`);
      }
    } else if (keysResult.error) {
      console.error("Keys error:", keysResult.error);
    }

    console.log("\n=== Summary ===");
    console.log(
      `  Wallet: ${totalWallet} sats | API Keys: ${totalApiKeys} sats`,
    );
    console.log(`  Grand Total: ${totalWallet + totalApiKeys} sats`);
  });

// Ping
program
  .command("ping")
  .description("Test connection to the daemon")
  .action(async () => {
    await handleDaemonCommand("/ping");
  });

// Refresh - refresh models and integrations
program
  .command("refresh")
  .description("Refresh routstr21 models and client integrations")
  .action(async () => {
    await ensureDaemonRunning();
    await refreshModelsAndClientsAction();
  });

// Models - list routstr21 models
const modelsCmd = program
  .command("models")
  .description("List available routstr21 models")
  .option("-r, --refresh", "Force refresh routstr21 models from Nostr", false)
  .option("-m, --model <id>", "Show providers for a specific model")
  .option(
    "-p, --paths",
    "With --model: show eligible automatic model paths in SDK candidate order; --all shows inventory",
    false,
  )
  .option(
    "-a, --all",
    "List every model the providers serve, not just the routstr21 list; with --model, include disabled providers; with --paths, show the full advertised route inventory",
    false,
  )
  .action(async (options: {
    refresh: boolean;
    model?: string;
    paths: boolean;
    all: boolean;
  }) => {
    if (options.paths && !options.model) {
      console.log("--paths requires --model <id>");
      process.exit(1);
    }

    await ensureDaemonRunning();

    if (options.model) {
      // Show providers for specific model. Disabled nodes are hidden unless
      // --all asks for them: routing excludes them, so their price is not one
      // a request can get. The same flag drives the path inventory below.
      const includeDisabled = options.all ? "?includeDisabled=true" : "";
      const result = await callDaemon(
        `/models/${encodeURIComponent(options.model)}/providers${includeDisabled}`,
      );
      if (result.error) {
        console.log(result.error);
        // With --paths the inventory is still worth showing: a node can serve
        // the model's routes while the provider ranking cannot price it.
        if (!options.paths) process.exit(1);
      }

      const modelData = result.output as ModelWithProviders | undefined;

      if (!modelData) {
        if (!result.error) console.log("Model not found");
        if (!options.paths) process.exit(1);
      }

      if (modelData) {
        // One table, ordered the way the router ranks the nodes (see
        // utils/model-providers); the model-path inventory follows under
        // --paths.
        console.log("");
        if (options.paths) console.log("Provider catalog prices (plain/unpinned ranking; NOT automatic model-path order):");
        console.log(formatModelProviders(modelData));
        console.log("");
      }

      if (options.paths) {
        // Preserve the HTTP inventory view for existing clients. The CLI opts
        // into executable automatic candidates unless --all requests inventory.
        const pathsParams = new URLSearchParams();
        if (options.refresh) pathsParams.set("refresh", "true");
        if (options.all) pathsParams.set("includeDisabled", "true");
        else pathsParams.set("view", "candidates");
        const query = pathsParams.toString();
        const pathsResult = await callDaemon(
          `/models/${encodeURIComponent(options.model)}/paths${query ? `?${query}` : ""}`,
        );
        if (pathsResult.error) {
          console.log(pathsResult.error);
          process.exit(1);
        }
        const pathsOutput = pathsResult.output as ModelPathsOutput | undefined;
        console.log("");
        console.log(
          pathsOutput
            ? formatModelPaths(pathsOutput)
            : "No model paths available",
        );
        console.log("");
      }

      return;
    }

    // List models. `--all` asks the daemon for its whole catalog instead of
    // the curated routstr21 list; both share one population pass, so the flag
    // costs no extra network I/O.
    const params = new URLSearchParams();
    if (options.refresh) params.set("refresh", "true");
    if (options.all) params.set("all", "true");
    const query = params.toString();
    const result = await callDaemon(`/models${query ? `?${query}` : ""}`);
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    if (
      result.output &&
      typeof result.output === "object" &&
      "models" in result.output
    ) {
      const models = (result.output as { models: RoutstrModel[] }).models;
      // The label has to say which catalog this is: a model missing from the
      // routstr21 list is still listed here under --all, and the count is no
      // longer the curated count.
      const catalog = options.all ? "available" : "routstr21";
      if (models.length === 0) {
        console.log(`No ${catalog} models found`);
      } else {
        console.log(`\nFound ${models.length} ${catalog} models:`);
        console.log(
          options.all
            ? "(Every model the enabled providers advertise; the routstr21 list is the curated," +
                " routable subset. Use 'routstrd models -m <model_id>' to see providers and pricing.)\n"
            : "(Use 'routstrd models -m <model_id>' to see providers and pricing; add --paths for the" +
                " model-path inventory. Pass --all to list every model the providers serve.)\n",
        );
        models.forEach((model, i) => {
          const details = [
            model.name && model.name !== model.id ? model.name : null,
            model.context_length ? `${model.context_length} ctx` : null,
          ]
            .filter(Boolean)
            .join(" - ");
          console.log(
            `  ${String(i + 1).padStart(2)}. ${model.id}${details ? ` (${details})` : ""}`,
          );
        });
        console.log("");
      }
    }
  });

/**
 * The daemon reads `autoModelPath` per routed request, so writing it through
 * the settings endpoint applies it to the next request — no restart. (Editing
 * config.json by hand still needs one: the daemon re-reads the file at boot.)
 */
modelsCmd
  .command("auto-model-path [state]")
  .description("Show or change automatic model-path selection (on|off|toggle)")
  .action(async (state: string | undefined) => {
    // Validate before touching the daemon: a typo must not start one.
    const parsed = parseAutoModelPathArg(state);
    if (parsed.kind === "invalid") {
      console.error(
        `Invalid state '${parsed.value}'. Use 'on', 'off', 'toggle', or omit it to show the current setting.`,
      );
      process.exit(1);
    }

    if (parsed.kind === "status") {
      for (const line of formatAutoModelPathStatus(
        await fetchAutoModelPathStatus(),
      )) {
        console.log(line);
      }
      return;
    }

    // Writing goes through the daemon: it owns the config file it loads at
    // startup, and on a remote node it is the only place the file exists.
    await ensureDaemonRunning();
    const status = await fetchAutoModelPathStatus();

    // `toggle` flips what is persisted, so repeating it always alternates.
    const enabled =
      parsed.kind === "toggle" ? !status.configured : parsed.enabled;

    const result = await callDaemon("/settings/auto-model-path", {
      method: "POST",
      body: { enabled },
    });
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as
      | { message?: string; autoModelPath?: unknown }
      | undefined;
    console.log(
      output?.message ?? `Auto model path ${enabled ? "enabled" : "disabled"}.`,
    );

    if (output?.autoModelPath === enabled) {
      console.log("Applied to the running daemon; no restart needed.");
      return;
    }

    console.log(
      "The daemon did not report the new value — restart it to apply it: routstrd restart",
    );
  });

program
  .command("usage")
  .description("Show recent usage logs and total sats cost")
  .option("-n, --limit <number>", "Number of recent usage entries", "10")
  .action(async (options: { limit: string }) => {
    await ensureDaemonRunning();

    const requested = Number.parseInt(options.limit, 10);
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, 1000)
        : 10;

    const result = await callAuth(`/usage?limit=${limit}`);
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    // The daemon returns { output: UsageEntry[] } where output is the array directly
    const entries = (result.output as UsageEntry[] | undefined) || [];

    // Calculate totals from entries
    const totalEntries = entries.length;
    const totalSatsCost = entries.reduce(
      (sum, e) => sum + (e.satsCost || 0),
      0,
    );
    const recentSatsCost = totalSatsCost; // For now, recent = total since we don't have time window

    console.log(`Usage entries: showing ${entries.length} of ${totalEntries}`);
    console.log(`Total sats cost (all time): ${totalSatsCost.toFixed(3)} sats`);
    console.log(`Sats cost (shown entries): ${recentSatsCost.toFixed(3)} sats`);

    if (entries.length === 0) {
      console.log("No usage entries yet.");
      return;
    }

    console.log("");
    entries.forEach((entry, index) => {
      const time = new Date(entry.timestamp).toISOString();
      const provider = entry.baseUrl || "unknown";
      const reqId = entry.requestId || "unknown";
      const client = entry.client ? ` | client: ${entry.client}` : "";
      console.log(
        `${index + 1}. ${time} | ${entry.modelId} | ${provider} | ${entry.satsCost.toFixed(3)} sats${client}`,
      );
      console.log(
        `   tokens p/c/t: ${entry.promptTokens}/${entry.completionTokens}/${entry.totalTokens} | request: ${reqId}`,
      );
    });
  });

// Providers - list and manage providers
const providersCmd = program
  .command("providers")
  .description("List and manage providers");

// Strict index parsing: parseInt accepts garbage like "3abc" (-> 3) or
// "0x5" (-> 0), which would silently act on the wrong provider.
const parseProviderIndices = (raw: string[]): number[] => {
  const valid: number[] = [];
  const invalid: string[] = [];
  for (const s of raw) {
    if (/^\d+$/.test(s)) {
      valid.push(parseInt(s, 10));
    } else {
      invalid.push(s);
    }
  }
  if (invalid.length > 0) {
    console.log(`Ignoring invalid index argument(s): ${invalid.join(", ")}`);
  }
  return valid;
};

// Enable/disable targets: a pure-digit argument is a provider index, anything
// else is a kind-38425 review label (e.g. `sandbox`). Indices and labels can be
// mixed, and the split is shared by both commands so they stay symmetric.
const splitProviderTargets = (
  raw: string[],
): { indices: number[]; labels: string[] } => {
  const indices: number[] = [];
  const labels: string[] = [];
  for (const target of raw) {
    if (/^\d+$/.test(target)) {
      indices.push(parseInt(target, 10));
    } else if (target.trim().length > 0) {
      labels.push(target.trim());
    }
  }
  return { indices, labels };
};

// A provider number is a position in the list the daemon just rendered, so a
// number it cannot resolve (0, or one past the end) must say so: silently
// acting on nothing looks exactly like success.
const printSkippedProviderIndices = (skipped: unknown[] | undefined): void => {
  if (!skipped || skipped.length === 0) return;
  console.log(
    `Ignored invalid index(es): ${skipped.join(", ")} — run \`routstrd providers list\` for the current numbers.`,
  );
};

providersCmd
  .command("list")
  .description("List reachable providers with their enabled/disabled status")
  .option("--refresh", "Force re-fetch all Nostr events and refresh models from all enabled providers", false)
  .option(
    "--all",
    "Also list unreachable providers (down, or never answered); hidden by default",
    false,
  )
  .action(async (options: { refresh: boolean; all: boolean }) => {
    await ensureDaemonRunning();

    const params = new URLSearchParams();
    if (options.refresh) params.set("refresh", "true");
    if (options.all) params.set("all", "true");
    const query = params.size > 0 ? `/providers?${params}` : "/providers";
    const result = await callDaemon(query);
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as ProviderListOutput | undefined;

    if (!output?.providers) {
      console.log("No providers found.");
      return;
    }

    // An older daemon reports every node and no reachability fields; the
    // renderer degrades to the plain list rather than pretending everything is
    // reachable. See utils/provider-reachability.
    console.log(formatProviderList(output));
  });

providersCmd
  .command("disable <targets...>")
  .description(
    "Disable providers by index or by Nostr review label (e.g., routstrd providers disable 1 3 6, or routstrd providers disable sandbox)",
  )
  .action(async (targets: string[]) => {
    await ensureDaemonRunning();

    const { indices, labels } = splitProviderTargets(targets);
    if (indices.length === 0 && labels.length === 0) {
      console.log("No valid indices or labels provided.");
      process.exit(1);
    }

    const result = await callDaemon("/providers/disable", {
      method: "POST",
      body: { indices, labels },
    });

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as
      | {
          message: string;
          disabled: string[];
          remainingEnabled?: string[];
          enabledReviewLabels?: string[];
          enabledLabels?: string[];
          unmatchedLabels?: string[];
          skipped?: unknown[];
        }
      | undefined;
    if (output) {
      console.log(output.message);
      for (const url of output.disabled) {
        console.log(`  - ${url}`);
      }
      for (const url of output.remainingEnabled ?? []) {
        console.log(`  - Remains enabled (effective policy): ${url}`);
      }
      const effectiveLabels = output.enabledReviewLabels ?? output.enabledLabels;
      if (effectiveLabels && effectiveLabels.length > 0) {
        console.log(
          `Enabled review labels: ${effectiveLabels.join(", ")}`,
        );
      }
      if (output.unmatchedLabels && output.unmatchedLabels.length > 0) {
        console.log(
          `No providers matched review label(s): ${output.unmatchedLabels.join(", ")}`,
        );
      }
      printSkippedProviderIndices(output.skipped);
    }
  });

providersCmd
  .command("enable <targets...>")
  .description(
    "Enable providers by index or by Nostr review label (e.g., routstrd providers enable 1 3 6, or routstrd providers enable sandbox)",
  )
  .action(async (targets: string[]) => {
    await ensureDaemonRunning();

    // Numeric targets are provider indices; everything else is a kind-38425
    // review label (e.g. `sandbox`). A label opts into the daemon's review
    // label policy; manual overrides and negative review verdicts still apply.
    const { indices, labels } = splitProviderTargets(targets);

    if (indices.length === 0 && labels.length === 0) {
      console.log("No valid indices or labels provided.");
      process.exit(1);
    }

    const result = await callDaemon("/providers/enable", {
      method: "POST",
      body: { indices, labels },
    });

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as
      | {
          message: string;
          enabled: string[];
          remainingDisabled?: string[];
          enabledReviewLabels?: string[];
          enabledLabels?: string[];
          matchedLabels?: string[];
          unmatchedLabels?: string[];
          skipped?: unknown[];
        }
      | undefined;
    if (output) {
      console.log(output.message);
      for (const url of output.enabled) {
        console.log(`  - ${url}`);
      }
      for (const url of output.remainingDisabled ?? []) {
        console.log(`  - Remains disabled (effective policy): ${url}`);
      }
      const effectiveLabels = output.enabledReviewLabels ?? output.enabledLabels;
      if (effectiveLabels && effectiveLabels.length > 0) {
        console.log(
          `Enabled review labels: ${effectiveLabels.join(", ")}`,
        );
      }
      if (output.unmatchedLabels && output.unmatchedLabels.length > 0) {
        console.log(
          `No providers matched review label(s): ${output.unmatchedLabels.join(", ")}`,
        );
      }
      printSkippedProviderIndices(output.skipped);
    }
  });

providersCmd
  .command("nostr-sync <indices...>")
  .description(
    "Remove manual enable/disable overrides and return providers to their Nostr review-based state (e.g., routstrd providers nostr-sync 1 3 6)",
  )
  .action(async (indices: string[]) => {
    await ensureDaemonRunning();

    const indexNums = parseProviderIndices(indices);
    if (indexNums.length === 0) {
      console.log("No valid indices provided.");
      process.exit(1);
    }

    const result = await callDaemon("/providers/nostr-sync", {
      method: "POST",
      body: { indices: indexNums },
    });

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as
      | {
          message: string;
          providers: Array<{ baseUrl: string; disabled: boolean }>;
          skipped?: unknown[];
        }
      | undefined;
    if (output) {
      console.log(output.message);
      for (const provider of output.providers) {
        const status = provider.disabled
          ? "DISABLED (nostr review)"
          : "enabled";
        console.log(`  - ${provider.baseUrl} -> ${status}`);
      }
      if (output.skipped && output.skipped.length > 0) {
        printSkippedProviderIndices(output.skipped);
      }
    }
  });

providersCmd
  .command("reviews")
  .description(
    "Show all known providers with their stored review events and event IDs",
  )
  .action(async () => {
    await ensureDaemonRunning();

    const result = await callDaemon("/providers/reviews");
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as
      | {
          providers: Array<{
            index: number;
            baseUrl: string;
            disabled: boolean;
            nodePubkeys: string[];
            labels: string[];
            reviewCount: number;
            reviews: Array<{
              eventId: string;
              createdAt: number;
              authorPubkey: string | null;
              nodePubkey: string | null;
              label: string;
              tags: string[][];
            }>;
          }>;
          unmatchedReviews: Array<{
            eventId: string;
            createdAt: number;
            authorPubkey: string | null;
            nodePubkey: string | null;
            label: string;
            tags: string[][];
          }>;
          enabledLabels: string[];
          totalCount: number;
          reviewEventCount: number;
        }
      | undefined;

    if (!output) {
      console.log("No provider review data available.");
      return;
    }

    console.log(
      `Providers (${output.totalCount} total, ${output.reviewEventCount} stored review events):\n`,
    );
    console.log(
      `Enabled review labels: ${output.enabledLabels.length > 0 ? output.enabledLabels.join(", ") : "(defaults only)"}\n`,
    );

    for (const provider of output.providers) {
      const status = provider.disabled ? "DISABLED" : "enabled ";
      console.log(
        `  [${provider.index}] ${status}  ${provider.baseUrl}  (${provider.reviewCount} review${provider.reviewCount === 1 ? "" : "s"})`,
      );

      if (provider.nodePubkeys.length > 0) {
        console.log(`      node pubkeys: ${provider.nodePubkeys.join(", ")}`);
      }
      if (provider.labels.length > 0) {
        console.log(`      labels:       ${provider.labels.join(", ")}`);
      }

      for (const review of provider.reviews) {
        const label = review.label || "review";
        const created = new Date(review.createdAt * 1000).toISOString();
        console.log(`      - ${label}  eventId: ${review.eventId}`);
        console.log(`          node:   ${review.nodePubkey ?? "(none)"}`);
        console.log(`          author: ${review.authorPubkey ?? "(none)"}`);
        console.log(`          at:     ${created}`);
      }
    }

    if (output.unmatchedReviews.length > 0) {
      console.log(
        `\n  Unmatched review events (${output.unmatchedReviews.length} — node pubkey not in any known provider):`,
      );
      for (const review of output.unmatchedReviews) {
        const created = new Date(review.createdAt * 1000).toISOString();
        console.log(`      - eventId: ${review.eventId}`);
        console.log(`          node:   ${review.nodePubkey ?? "(none)"}`);
        console.log(`          at:     ${created}`);
      }
    }
  });

// Cooldowns - providers/models the router is currently skipping
program
  .command("cooldowns")
  .description(
    "List providers and models currently on cooldown (temporarily skipped by the router), or clear them with --reset",
  )
  .option("--json", "Print the raw daemon response as JSON", false)
  .option(
    "--reset",
    "Clear all active cooldowns and failure strikes so every provider is retried now",
    false,
  )
  .action(async (options: { json: boolean; reset: boolean }) => {
    await ensureDaemonRunning();

    if (options.reset) {
      let result: CommandResponse;
      try {
        result = await callDaemon("/cooldowns/reset", { method: "POST" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A daemon built before this command existed has no reset route: it
        // either 404s or falls through to the chat proxy and rejects the
        // request for a missing `model` field.
        if (
          message.includes("404") ||
          message === "Only POST is supported." ||
          message.includes("Missing required 'model' field")
        ) {
          console.error(
            "The running daemon has no /cooldowns/reset endpoint, so it cannot reset cooldowns. " +
              "Restart it on a newer build (routstrd service restart) and try again.",
          );
          process.exit(1);
        }
        throw error;
      }

      if (result.error) {
        console.log(result.error);
        process.exit(1);
      }

      const output = result.output as CooldownsResetOutput | undefined;
      if (options.json) {
        console.log(JSON.stringify(output ?? {}, null, 2));
        return;
      }

      if (!output) {
        console.log("No cooldown reset data returned by the daemon.");
        return;
      }

      console.log(formatCooldownsReset(output));
      return;
    }

    let result: CommandResponse;
    try {
      result = await callDaemon("/cooldowns");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A daemon built before this command existed has no /cooldowns route:
      // it either 404s or falls through to the "POST only" catch-all.
      if (message.includes("404") || message === "Only POST is supported.") {
        console.error(
          "The running daemon has no /cooldowns endpoint, so it cannot report cooldowns. " +
            "Restart it on a newer build (routstrd service restart) and try again.",
        );
        process.exit(1);
      }
      throw error;
    }

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as CooldownsOutput | undefined;
    if (options.json) {
      console.log(JSON.stringify(output ?? {}, null, 2));
      return;
    }

    if (!output) {
      console.log("No cooldown data returned by the daemon.");
      return;
    }

    console.log(formatCooldowns(output));
  });

// Clients - list and manage clients
const clientsCmd = program
  .command("clients")
  .description("List and manage clients")
  .option(
    "--manual-refresh",
    "Refresh routstr21 models and all client integrations now",
    false,
  )
  .option(
    "--disable-automatic-refresh",
    "Disable the daemon's scheduled refresh job",
    false,
  )
  .option(
    "--enable-automatic-refresh",
    "Re-enable the daemon's scheduled refresh job",
    false,
  )
  .action(
    async (options: {
      manualRefresh: boolean;
      disableAutomaticRefresh: boolean;
      enableAutomaticRefresh: boolean;
    }) => {
      if (options.disableAutomaticRefresh && options.enableAutomaticRefresh) {
        console.error(
          "error: --disable-automatic-refresh and --enable-automatic-refresh are mutually exclusive.",
        );
        process.exit(1);
      }

      if (
        !options.manualRefresh &&
        !options.disableAutomaticRefresh &&
        !options.enableAutomaticRefresh
      ) {
        clientsCmd.help({ error: true });
        return;
      }

      if (options.manualRefresh) {
        await ensureDaemonRunning();
        await refreshModelsAndClientsAction();
      }

      if (options.disableAutomaticRefresh || options.enableAutomaticRefresh) {
        await setAutomaticRefreshAction(options.enableAutomaticRefresh);
      }
    },
  );

clientsCmd
  .command("list")
  .description("List all clients")
  .action(async () => {
    await listClientsAction();
  });

clientsCmd
  .command("delete <id>")
  .description("Delete a client by its ID")
  .action(async (id: string) => {
    await deleteClientAction(id);
  });

clientsCmd
  .command("add")
  .description("Add a new client or set up client integrations")
  .option("-n, --name <name>", "Client name")
  .option("--opencode", "Set up OpenCode integration")
  .option("--openclaw", "Set up OpenClaw integration")
  .option("--pi-agent", "Set up Pi Agent integration")
  .option("--claude-code", "Set up Claude Code integration")
  .option("--hermes", "Set up Hermes integration")
  .action(
    async (options: {
      name?: string;
      opencode?: boolean;
      openclaw?: boolean;
      piAgent?: boolean;
      claudeCode?: boolean;
      hermes?: boolean;
    }) => {
      await addClientAction(options);
    },
  );

// Npubs - manage npubs (admin and user roles)
const npubsCmd = program
  .command("npubs")
  .description("Manage npubs on the daemon (admin or user roles)")
  .hook("preAction", async (_thisCommand, actionCommand) => {
    // Both the bare command and `whoami` answer from the local config, so they
    // must work without a node.
    if (actionCommand === npubsCmd || actionCommand?.name() === "whoami") {
      return;
    }
    const config = await loadConfig();
    if (!config.daemonUrl && !config.authUrl) {
      console.error("npubs needs a remote node. Run 'routstrd remote <url>' to set one up.");
      const npubLine = formatOwnNpub(config);
      if (npubLine) console.error(npubLine);
      process.exit(1);
    }
  });

type NpubEntry = {
  npub: string;
  name: string | null;
  role: string;
  /**
   * Monthly spend cap in sats. `null` means unlimited; an absent field means
   * the response did not report a cap (typically an older auth proxy), so the
   * cap is unknown rather than unlimited.
   */
  monthlyLimitSats?: number | null;
  /** Sats spent in the current calendar month (read-only). */
  monthlyUsedSats?: number;
};

/**
 * Resolve the display name for a newly registered npub.
 *
 * Names are mandatory, so a missing `--name` prompts on a terminal and fails
 * with a usable hint everywhere else (scripts, CI, piped invocations). Returns
 * the trimmed name, or exits.
 */
async function requireNpubName(
  raw: string | undefined,
  subject: string,
  usage: string,
): Promise<string> {
  const parsed = parseRequiredNpubName(raw);
  if (parsed.error) {
    console.error(parsed.error);
    process.exit(1);
  }
  if (parsed.name !== undefined) return parsed.name;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`Missing required --name.\n${usage}`);
    process.exit(1);
  }

  const rl = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      // `null` means EOF/Ctrl+D, which aborts instead of re-prompting.
      const answer = await new Promise<string | null>((resolve) => {
        let settled = false;
        const done = (value: string | null) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        rl.question(`Display name for ${subject} (required): `, (value: string) =>
          done(value),
        );
        rl.once("close", () => done(null));
      });

      if (answer === null) {
        console.error(`\nA display name is required.\n${usage}`);
        process.exit(1);
      }

      const validated = parseRequiredNpubName(answer);
      if (validated.name !== undefined) return validated.name;
      console.error(validated.error ?? "Invalid display name.");
    }
  } finally {
    rl.close();
  }
}

/**
 * Parse a per-npub monthly spend cap in sats. Rejects fractions, negatives and
 * non-numeric values; 0 is a valid cap that blocks every paid request.
 */
export function parseMonthlyLimitSats(
  raw: string | undefined,
): { value?: number; error?: string } {
  if (raw === undefined) return {};
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { error: "Invalid --limit-sats. Expected a non-negative whole number of sats." };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    return { error: "Invalid --limit-sats. Value is too large." };
  }
  return { value };
}

/**
 * Describe a monthly cap reported by the auth proxy. The field is tri-state: a
 * number is a cap, an explicit `null` is unlimited, and an absent field leaves
 * the cap unknown — most likely an auth proxy that predates spend limits.
 * Reporting absent as "unlimited" would claim enforcement we cannot verify.
 */
function describeMonthlyLimit(value: number | null | undefined): string {
  if (typeof value === "number") return `${value} sats/month`;
  if (value === null) return "unlimited";
  return "unknown (auth proxy does not report spend limits)";
}

/** Human-readable monthly cap line for `npubs list`. */
function formatNpubMonthlyLimit(entry: NpubEntry): string {
  const used = typeof entry.monthlyUsedSats === "number"
    ? ` (${entry.monthlyUsedSats} used)`
    : "";
  return `limit: ${describeMonthlyLimit(entry.monthlyLimitSats)}${used}`;
}

/**
 * Warn when the cap reported back differs from the cap that was requested.
 * Older auth proxies may ignore `monthlyLimitSats` entirely (absent field), and
 * a proxy that validates differently may clamp or reinterpret the value, so
 * neither case can be assumed to have applied the request. `undefined` means
 * no cap was requested, which never warns.
 */
function warnIfMonthlyLimitUnconfirmed(
  requested: number | null | undefined,
  reported: number | null | undefined,
): void {
  if (requested === undefined || reported === requested) return;
  if (reported === undefined) {
    console.warn(
      "Warning: the auth proxy did not confirm the monthly limit. It may be an older auth proxy that ignores spend limits; upgrade it to enforce this cap.",
    );
    return;
  }
  console.warn(
    `Warning: the auth proxy reported ${describeMonthlyLimit(reported)} as the monthly limit, but ${describeMonthlyLimit(requested)} was requested. Check the auth proxy version before relying on this cap.`,
  );
}

npubsCmd
  .command("whoami")
  .description("Print your own npub from the local config (works without a remote node)")
  .action(async () => {
    const config = await loadConfig();
    const npubLine = formatOwnNpub(config);
    if (!npubLine) {
      console.error(
        "No Nostr identity configured. Run 'routstrd onboard' (local) or 'routstrd remote <url>' to create one.",
      );
      process.exit(1);
    }
    console.log(npubLine);
  });

// A bare `routstrd npubs` is a help request, but it is also the moment an
// operator most wants their own npub — so print it above the usage block
// instead of only listing subcommands. Both go to stderr, matching where
// commander writes help for a command that needs a subcommand.
npubsCmd.action(async () => {
  const config = await loadConfig();
  const npubLine = formatOwnNpub(config);
  if (npubLine) console.error(npubLine);
  npubsCmd.help({ error: true });
});

npubsCmd
  .command("list")
  .description("List configured npubs with their roles, names and monthly spend limits")
  .action(async () => {
    await ensureDaemonRunning();
    const config = await loadConfig();
    const userNpub = getUserNpub(config);
    const result = await callAuth("/npubs");
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }
    // Handle both wrapped { output: { npubs } } and direct { npubs } response formats
    const data = (result.output as { npubs?: NpubEntry[] } | undefined)?.npubs
      ? result.output
      : result;
    const npubs = (data as { npubs?: NpubEntry[] } | undefined)?.npubs ?? [];
    if (npubs.length === 0) {
      console.log("No npubs configured. Run 'routstrd npubs register' to register yourself as the first admin.");
      return;
    }
    console.log(`Npubs (${npubs.length}):`);
    let found = false;
    for (const entry of npubs) {
      const marker = entry.npub === userNpub ? " → you" : "";
      if (entry.npub === userNpub) found = true;
      const name = entry.name ? ` "${entry.name}"` : " (unnamed)";
      console.log(`- ${entry.npub} [${entry.role}]${name}${marker} — ${formatNpubMonthlyLimit(entry)}`);
    }
    if (userNpub && !found) {
      console.log("");
      console.log(
        "Your npub is not in the npub list. Ask an admin to add your npub:",
      );
      console.log(`  ${userNpub}`);
    }
  });

npubsCmd
  .command("register")
  .description("Register yourself as the first admin (only when no admins exist)")
  .option("-n, --name <name>", "Display name for this npub (required; prompted when omitted)")
  .action(async (options: { name?: string }) => {
    await ensureDaemonRunning();
    const config = await loadConfig();
    const userNpub = getUserNpub(config);
    if (!userNpub) {
      console.error(
        "No Nostr identity configured. Run 'routstrd remote <url>' to set one up.",
      );
      process.exit(1);
    }
    const result = await callAuth("/npubs");
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }
    const data = (result.output as { npubs?: NpubEntry[] } | undefined)?.npubs
      ? result.output
      : result;
    const npubs = (data as { npubs?: NpubEntry[] } | undefined)?.npubs ?? [];
    if (npubs.length > 0) {
      console.log(`Admin npubs already configured (${npubs.length}). Ask your admin to add your npub. \n Your npub: ${userNpub}`);
      return;
    }
    const normalized = normalizeNostrPubkey(userNpub);
    if (!normalized) {
      console.error("Failed to normalize user npub.");
      process.exit(1);
    }
    const name = await requireNpubName(
      options.name,
      npubFromPubkey(normalized),
      "Register with a display name: routstrd npubs register --name \"Alice\"",
    );
    const body: Record<string, string | null> = {
      npub: npubFromPubkey(normalized),
      name,
    };
    const addResult = await callAuth("/npubs", {
      method: "POST",
      body,
    });
    if (addResult.error) {
      console.log(addResult.error);
      process.exit(1);
    }
    const output = addResult.output as
      | { npub?: string; name?: string | null; added?: boolean; error?: string }
      | undefined;
    if (output?.npub) {
      const nameSuffix = output.name ? ` ("${output.name}")` : "";
      console.log(`Successfully registered as first admin npub: ${output.npub}${nameSuffix}`);
    } else {
      console.log(`Successfully registered as first admin npub: ${userNpub}`);
    }
  });

npubsCmd
  .command("add <npub>")
  .description("Add a npub (hex pubkey or npub1...). Defaults to 'user' role unless --role is specified.")
  .option("-r, --role <role>", "Role for the npub: 'admin' or 'user' (default: 'user')", "user")
  .option("-n, --name <name>", "Display name for the npub (required; prompted when omitted)")
  .option("-l, --limit-sats <sats>", "Monthly soft cap in sats (resets on the 1st; omit for unlimited)")
  .action(async (npubArg: string, options: { role: string; name?: string; limitSats?: string }) => {
    await ensureDaemonRunning();
    const normalized = normalizeNostrPubkey(npubArg);
    if (!normalized) {
      console.error("Invalid npub value. Use npub1... or 64-char hex pubkey.");
      process.exit(1);
    }
    if (options.role !== "admin" && options.role !== "user") {
      console.error("Invalid role. Expected 'admin' or 'user'.");
      process.exit(1);
    }
    // Validate the cap before prompting for a name: a bad flag should fail fast.
    const limit = parseMonthlyLimitSats(options.limitSats);
    if (limit.error) {
      console.error(limit.error);
      process.exit(1);
    }
    const name = await requireNpubName(
      options.name,
      npubFromPubkey(normalized),
      `Add a display name: routstrd npubs add ${npubFromPubkey(normalized)} --name "Alice"`,
    );
    const body: Record<string, unknown> = {
      npub: npubFromPubkey(normalized),
      role: options.role,
      name,
    };
    if (limit.value !== undefined) body.monthlyLimitSats = limit.value;
    const result = await callAuth("/npubs", {
      method: "POST",
      body,
    });
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }
    const output = (result.output ?? result) as
      | { npub?: string; name?: string | null; role?: string; monthlyLimitSats?: number | null; added?: boolean; error?: string }
      | undefined;
    if (output?.npub) {
      const nameSuffix = output.name ? ` ("${output.name}")` : "";
      const limitSuffix = typeof output.monthlyLimitSats === "number"
        ? `, limit ${output.monthlyLimitSats} sats/month`
        : "";
      console.log(
        `${output.added ? "Added" : "Already configured"} npub: ${output.npub} [${output.role ?? "user"}]${nameSuffix}${limitSuffix}`,
      );
      warnIfMonthlyLimitUnconfirmed(limit.value, output.monthlyLimitSats);
    }
  });

npubsCmd
  .command("update <npub>")
  .description("Update the role, name and/or monthly soft spend cap of an existing npub (requires admin)")
  .option("-r, --role <role>", "New role: 'admin' or 'user'")
  .option("-n, --name <name>", "New display name (a name cannot be removed)")
  .option("-l, --limit-sats <sats>", "Monthly soft cap in sats (0 blocks all paid requests)")
  .option("--clear-limit", "Remove the monthly spend cap (unlimited)")
  .action(async (npubArg: string, options: { role?: string; name?: string; limitSats?: string; clearLimit?: boolean }) => {
    await ensureDaemonRunning();
    const normalized = normalizeNostrPubkey(npubArg);
    if (!normalized) {
      console.error("Invalid npub value. Use npub1... or 64-char hex pubkey.");
      process.exit(1);
    }
    if (options.role !== undefined && options.role !== "admin" && options.role !== "user") {
      console.error("Invalid role. Expected 'admin' or 'user'.");
      process.exit(1);
    }
    if (options.limitSats !== undefined && options.clearLimit) {
      console.error("Provide either '--limit-sats' or '--clear-limit', not both.");
      process.exit(1);
    }
    if (
      options.role === undefined &&
      options.name === undefined &&
      options.limitSats === undefined &&
      !options.clearLimit
    ) {
      console.error("Provide '--role', '--name', '--limit-sats' and/or '--clear-limit' to update.");
      process.exit(1);
    }
    const name = parseUpdatedNpubName(options.name);
    if (name.error) {
      console.error(name.error);
      process.exit(1);
    }
    const limit = parseMonthlyLimitSats(options.limitSats);
    if (limit.error) {
      console.error(limit.error);
      process.exit(1);
    }
    const body: Record<string, unknown> = {
      npub: npubFromPubkey(normalized),
    };
    if (options.role !== undefined) body.role = options.role;
    if (name.name !== undefined) body.name = name.name;
    if (limit.value !== undefined) body.monthlyLimitSats = limit.value;
    if (options.clearLimit) body.monthlyLimitSats = null;
    const requestedLimit = options.clearLimit ? null : limit.value;
    const result = await callAuth("/npubs", {
      method: "PATCH",
      body,
    });
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }
    // PATCH /npubs returns { npub, pubkey, name, role, monthlyLimitSats } at the top
    // level, not wrapped in { output }
    const data = (result.output ?? result) as
      | {
          npub?: string;
          pubkey?: string;
          name?: string | null;
          role?: string;
          monthlyLimitSats?: number | null;
          error?: string;
        }
      | undefined;
    if (data?.npub) {
      const parts: string[] = [];
      if (data.role) parts.push(`role='${data.role}'`);
      parts.push(`name=${data.name ? `"${data.name}"` : "(none)"}`);
      parts.push(`limit=${describeMonthlyLimit(data.monthlyLimitSats)}`);
      console.log(`Updated npub ${data.npub} (${parts.join(", ")}).`);
      warnIfMonthlyLimitUnconfirmed(requestedLimit, data.monthlyLimitSats);
    } else {
      console.log("Npub not found or update failed.");
    }
  });

npubsCmd
  .command("delete <npub>")
  .description("Delete an npub (hex pubkey or npub1...)")
  .action(async (npubArg: string) => {
    await ensureDaemonRunning();
    const normalized = normalizeNostrPubkey(npubArg);
    if (!normalized) {
      console.error("Invalid npub value. Use npub1... or 64-char hex pubkey.");
      process.exit(1);
    }
    const result = await callAuth(
      `/npubs/${encodeURIComponent(npubFromPubkey(normalized))}`,
      {
        method: "DELETE",
      },
    );
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }
    const output = result.output as
      | { removed?: boolean; error?: string }
      | undefined;
    console.log(
      output?.removed
        ? "Removed admin npub."
        : "Admin npub was not configured.",
    );
  });

program
  .command("history")
  .description("Show wallet transaction history")
  .option("-n, --limit <number>", "Number of entries to show", "50")
  .option("--offset <number>", "Number of entries to skip", "0")
  .option(
    "-t, --type <type...>",
    "Filter by transaction type (send, receive, mint, melt). Repeatable or comma-separated",
  )
  .option("-i, --id <id>", "Show a single transaction by its ID")
  .option("-v, --verbose", "Show full details instead of the summary line")
  .option("--json", "Output raw JSON with token objects (no encoding)")
  .action(async (options: {
    limit: string;
    offset: string;
    type?: string[];
    id?: string;
    verbose: boolean;
    json: boolean;
  }) => {
    await ensureDaemonRunning();

    const limit = Math.min(parseInt(options.limit, 10) || 50, 1000);
    const offset = parseInt(options.offset, 10) || 0;

    // Support both repeated flags (-t send -t mint) and comma-separated
    // values (-t send,mint).
    const requestedTypes = (options.type ?? [])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
    const unknownTypes = requestedTypes.filter(
      (value) => !isHistoryEntryType(value),
    );
    if (unknownTypes.length > 0) {
      console.error(
        `Unknown transaction type: ${unknownTypes.join(", ")}. Valid types: ${HISTORY_ENTRY_TYPES.join(", ")}.`,
      );
      process.exit(1);
    }

    const query = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
    });
    if (requestedTypes.length > 0) query.set("type", requestedTypes.join(","));
    if (options.id) query.set("id", options.id);

    const result = await callDaemon(`/wallet/history?${query.toString()}`);

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const data = result.output as
      | { entries?: Record<string, unknown>[]; offset?: number; limit?: number }
      | undefined;
    const entries = data?.entries || [];

    if (entries.length === 0) {
      if (options.id) {
        console.log(`No transaction found with ID ${options.id}.`);
      } else if (requestedTypes.length > 0) {
        console.log(
          `No ${requestedTypes.join(", ")} transactions found.`,
        );
      } else {
        console.log("No transaction history yet.");
      }
      return;
    }

    if (options.json) {
      const jsonOutput = entries.map((e: Record<string, unknown>) => {
        const entry = { ...e };
        delete entry.encodedToken;
        return entry;
      });
      console.log(JSON.stringify(jsonOutput, null, 2));
      return;
    }

    if (options.verbose) {
      for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        const display: Record<string, unknown> = {};
        for (const key of Object.keys(e).sort()) {
          display[key] = e[key];
        }
        if (e.encodedToken && e.token) {
          display.token = e.encodedToken;
          delete display.encodedToken;
        }
        console.log(JSON.stringify(display, null, 2));
      }
      return;
    }

    const idCol = "ID";
    const timeCol = "Date/Time";
    const typeCol = "Type";
    const statusCol = "Status";
    const mintCol = "Mint";
    const amtCol = "Amount";

    const rows = entries.map((entry: Record<string, unknown>) => {
      const id = String(entry.id ?? "");
      const time = new Date(Number(entry.createdAt)).toISOString().replace("T", " ").slice(0, 19);
      const type = String(entry.type ?? "").toUpperCase();
      const operationState =
        typeof entry.operationState === "string"
          ? entry.operationState
          : undefined;
      const status = historyStatus(
        String(entry.type ?? ""),
        String(entry.state ?? ""),
        operationState,
      );
      const mint = String(entry.mintUrl ?? "");
      const unit = String(entry.unit ?? "sat");
      const amount = `${entry.amount} ${unit}`;
      return { id, time, type, status, mint, amount };
    });

    const widths = {
      id: Math.max(idCol.length, ...rows.map((r) => r.id.length)),
      time: Math.max(timeCol.length, ...rows.map((r) => r.time.length)),
      type: Math.max(typeCol.length, ...rows.map((r) => r.type.length)),
      status: Math.max(statusCol.length, ...rows.map((r) => r.status.length)),
      mint: Math.max(mintCol.length, ...rows.map((r) => r.mint.length)),
      amount: Math.max(amtCol.length, ...rows.map((r) => r.amount.length)),
    };

    const pad = (s: string, w: number) => s.padEnd(w);
    const sep = Object.values(widths).map((w) => "-".repeat(w)).join(" | ");

    // A single transaction lookup prints just its summary line.
    if (!options.id) {
      console.log(
        `${pad(idCol, widths.id)} | ${pad(timeCol, widths.time)} | ${pad(typeCol, widths.type)} | ${pad(statusCol, widths.status)} | ${pad(mintCol, widths.mint)} | ${pad(amtCol, widths.amount)}`,
      );
      console.log(sep);
    }

    for (const row of rows) {
      console.log(
        `${pad(row.id, widths.id)} | ${pad(row.time, widths.time)} | ${pad(row.type, widths.type)} | ${pad(row.status, widths.status)} | ${pad(row.mint, widths.mint)} | ${pad(row.amount, widths.amount)}`,
      );
    }
  });

// Monitor - interactive TUI
program
  .command("monitor")
  .description("Open interactive TUI for usage monitoring (htop-like)")
  .action(async () => {
    const { runUsageTui } = await import("./tui/usage/index.ts");
    await runUsageTui();
  });

program
  .command("top")
  .description("Open interactive TUI for usage monitoring (alias for monitor)")
  .action(async () => {
    const { runUsageTui } = await import("./tui/usage/index.ts");
    await runUsageTui();
  });

program
  .command("send <target>")
  .description(
    "Shortcut: numbers send Cashu, non-numbers pay a Lightning invoice",
  )
  .option("--mint-url <url>", "Mint URL to use")
  .option(
    "--offline",
    "Send the closest available proofs without a swap; finalize manually",
    false,
  )
  .option(
    "--overpay-cap [factor]",
    "With --offline, allow a token worth up to FACTOR x the amount (default 3) before falling back to an online send",
  )
  .action(
    async (
      target: string,
      options: { mintUrl?: string; offline: boolean; overpayCap?: string | boolean },
    ) => {
      await warnIfWalletRecovering();
      if (isPositiveIntegerString(target)) {
        const overpayCap = parseOverpayCapOrExit(options.overpayCap);
        if (overpayCap !== undefined && !options.offline) {
          console.error("--overpay-cap requires --offline");
          process.exit(1);
        }
        await handleDaemonCommand("/wallet/send/cashu", {
          method: "POST",
          body: {
            amount: parsePositiveIntOrExit(target, "amount"),
            mintUrl: options.mintUrl,
            offline: options.offline,
            ...(overpayCap !== undefined ? { overpayCap } : {}),
          },
        });
        return;
      }
      if (options.offline) {
        console.error("--offline is only available when sending a Cashu amount");
        process.exit(1);
      }
      if (options.overpayCap !== undefined) {
        console.error("--overpay-cap requires --offline");
        process.exit(1);
      }

      await handleDaemonCommand("/wallet/send/bolt11", {
        method: "POST",
        body: {
          invoice: target,
          mintUrl: options.mintUrl,
        },
      });
    },
  );

program
  .command("receive <value>")
  .description(
    "Shortcut: numbers create a Lightning invoice, non-numbers receive a Cashu token",
  )
  .option("--mint-url <url>", "Mint URL to use for bolt11 receive")
  .action(async (value: string, options: { mintUrl?: string }) => {
    await warnIfWalletRecovering();
    if (isPositiveIntegerString(value)) {
      try {
        await ensureDaemonRunning();

        const result = await callDaemon("/wallet/receive/bolt11", {
          method: "POST",
          body: {
            amount: parsePositiveIntOrExit(value, "amount"),
            mintUrl: options.mintUrl,
          },
        });

        const output = result.output as
          | { invoice?: string; operationId?: string; amount?: number; mintUrl?: string }
          | undefined;

        if (typeof output?.invoice === "string" && output.invoice) {
          await printLightningInvoice(output.invoice);
          if (typeof output.operationId === "string") {
            await waitForMintQuote(output.operationId);
          }
          return;
        }

        if (result.output !== undefined) {
          console.log(JSON.stringify(result.output, null, 2));
        }
      } catch (error) {
        console.error((error as Error).message);
        process.exit(1);
      }
      return;
    }

    await handleDaemonCommand("/wallet/receive/cashu", {
      method: "POST",
      body: { token: value },
    });
  });

const walletCmd = program.command("wallet").description("Wallet operations");

walletCmd
  .command("status")
  .description("Check wallet status")
  .action(async () => {
    await handleDaemonCommand("/wallet/status");
  });

walletCmd
  .command("doctor")
  .description("Diagnose conflicting wallets (current routstrd wallet vs legacy cocod)")
  .action(async () => {
    const target = summarizeWalletDirectory(defaultWalletDir(), "canonical");
    const source = summarizeWalletDirectory(legacyCocodDir(), "legacy");
    console.log(renderWalletDoctor(target, source));
    if (diagnoseWallets(target, source).conflict) process.exit(1);
  });

walletCmd
  .command("unlock <passphrase>")
  .description("Unlock the wallet")
  .action(async (passphrase: string) => {
    await handleDaemonCommand("/wallet/unlock", {
      method: "POST",
      body: { passphrase },
    });
  });

walletCmd
  .command("balance")
  .description("Get wallet balance")
  .action(async () => {
    await handleDaemonCommand("/wallet/balance");
  });

walletCmd
  .command("sweep-offline")
  .description("Check and reclaim aged pending offline Cashu sends (invalidates unclaimed tokens)")
  .option("--mint-url <url>", "Only sweep tokens from this mint")
  .option("--min-age <hours>", "Minimum token age in hours (default: 168, seven days)", "168")
  .option("--dry-run", "List candidates locally without mint requests or changes", false)
  .option("-y, --yes", "Confirm invalidating outstanding unclaimed tokens", false)
  .action(async (options: { mintUrl?: string; minAge: string; dryRun: boolean; yes: boolean }) => {
    const hours = Number(options.minAge);
    const minAgeMs = Math.round(hours * 60 * 60 * 1000);
    if (!options.minAge.trim() || !Number.isFinite(hours) || hours < 0 || !Number.isSafeInteger(minAgeMs)) {
      console.error(`Invalid --min-age value: ${options.minAge}`);
      process.exitCode = 1;
      return;
    }
    if (options.mintUrl !== undefined) {
      try { options.mintUrl = normalizeOfflineSweepMintUrl(options.mintUrl); }
      catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
      }
    }
    if (!options.dryRun && !options.yes) {
      if (!process.stdin.isTTY) {
        console.error("Offline sweeping requires confirmation. Preview with --dry-run or explicitly use --yes.");
        process.exitCode = 1;
        return;
      }
      const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question("WARNING: Reclaiming invalidates outstanding unclaimed tokens, even if recipients still hold them. Mint fees may apply. Continue? [y/N] ", (value: string) => {
          rl.close();
          resolve(value.trim().toLowerCase());
        });
      });
      if (answer !== "y" && answer !== "yes") {
        console.log("Aborted.");
        return;
      }
    }
    try {
      await ensureDaemonRunning();
      const result = await callDaemon("/wallet/sweep-offline", {
        method: "POST",
        body: { mintUrl: options.mintUrl, minAgeMs, dryRun: options.dryRun, confirmed: !options.dryRun },
      });
      if (result.error) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      const output = result.output as import("./daemon/wallet/offline-sweep").OfflineSweepResult;
      console.log(options.dryRun ? "Offline sweep candidates (not checked with mint):" : "Offline sweep results:");
      console.log(`  Candidates: ${output.candidates}; skipped: ${output.skipped}`);
      console.log(`  Claimed: ${output.claimed}; reclaimed: ${output.reclaimed}; unresolved: ${output.unresolved}; failed: ${output.failed}; stuck: ${output.stuck}`);
      for (const op of output.operations) {
        console.log(`  ${op.operationId} ${op.mintUrl} ${op.amount} sat ${op.outcome}${op.error ? `: ${op.error}` : ""}`);
      }
      if (options.mintUrl && output.candidates === 0 && !output.stuck) {
        console.warn(`No aged pending offline sends matched mint ${options.mintUrl}; check the mint filter and minimum age.`);
      }
      if (output.failed || output.unresolved || output.stuck) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

walletCmd
  .command("cleanup")
  .description("Clear stuck pending/in-flight wallet operations")
  .option("--mint-url <url>", "Only clean up operations for this mint URL")
  .option(
    "--min-age <hours>",
    "Minimum age for reclaiming sends/cancelling melts, in hours (default: 168, one week; expired mint quotes are checked with their mint)",
    "168",
  )
  .option("--dry-run", "Report what would be cleaned without applying changes", false)
  .option(
    "--force",
    "Fail expired mint quotes without confirming UNPAID with the mint (may strand paid quotes)",
    false,
  )
  .option("-y, --yes", "Skip confirmation prompt", false)
  .action(
    async (options: {
      mintUrl?: string;
      minAge: string;
      dryRun: boolean;
      force: boolean;
      yes: boolean;
    }) => {
      const minAgeHours = Number.parseFloat(options.minAge);
      if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
        console.error(`Invalid --min-age value: ${options.minAge}`);
        process.exit(1);
      }

      if (!options.dryRun && !options.yes) {
        const rl = require("readline").createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            options.force
              ? "WARNING: --force fails expired mint quotes WITHOUT checking the mint and may strand paid sats. It also reclaims old pending sends and cancels prepared melts. Continue? [y/N] "
              : "This will fail expired mint quotes confirmed unpaid, reclaim old pending sends, and cancel prepared melts. Continue? [y/N] ",
            (value: string) => {
              rl.close();
              resolve(value.trim().toLowerCase());
            },
          );
        });
        if (answer !== "y" && answer !== "yes") {
          console.log("Aborted.");
          return;
        }
      }

      try {
        await ensureDaemonRunning();

        const result = await callDaemon("/wallet/cleanup", {
          method: "POST",
          body: {
            mintUrl: options.mintUrl,
            minAgeMs: Math.round(minAgeHours * 60 * 60 * 1000),
            dryRun: options.dryRun === true,
            force: options.force === true,
          },
        });

        if (result.error) {
          console.log(result.error);
          process.exit(1);
        }

        const output = result.output as
          | {
              dryRun?: boolean;
              failedMintQuotes?: number;
              mintQuoteCandidates?: number;
              leftForRecovery?: number;
              reclaimedSends?: number;
              cancelledMelts?: number;
              skipped?: number;
              errors?: Array<{ operationId: string; error: string }>;
            }
          | undefined;

        if (output) {
          const prefix = output.dryRun ? "Would clean up:" : "Cleaned up:";
          console.log(prefix);
          if (output.dryRun) {
            console.log(
              `  Expired mint quote candidates (not checked with mint): ${output.mintQuoteCandidates ?? 0}`,
            );
          } else {
            console.log(`  Expired mint quotes failed: ${output.failedMintQuotes ?? 0}`);
          }
          console.log(
            `  Expired quotes kept for recovery (paid/issued/unverified): ${output.leftForRecovery ?? 0}`,
          );
          console.log(`  Pending sends reclaimed: ${output.reclaimedSends ?? 0}`);
          console.log(
            `  Prepared melts cancelled: ${output.cancelledMelts ?? 0}`,
          );
          console.log(
            `  Skipped (still recent or already terminal): ${output.skipped ?? 0}`,
          );
          if (output.errors && output.errors.length > 0) {
            console.log("\nErrors:");
            for (const e of output.errors) {
              console.log(`  - ${e.operationId}: ${e.error}`);
            }
          }
        }
      } catch (error) {
        const message = (error as Error).message;
        if (
          message?.includes("fetch failed") ||
          message?.includes("Connection refused")
        ) {
          console.error("Daemon is not running");
          process.exit(1);
        }
        console.error(message);
        process.exit(1);
      }
    },
  );

walletCmd
  .command("check-proofs")
  .description(
    "Ask each mint whether our ready/inflight proofs are spent, and mark the spent ones",
  )
  .option("--mint-url <url>", "Only check proofs held for this mint URL")
  .option("--timeout <ms>", "Per-mint check timeout in milliseconds", "30000")
  .option(
    "--dry-run",
    "Report what would be marked without applying changes",
    false,
  )
  .option("-y, --yes", "Skip confirmation prompt", false)
  .action(
    async (options: {
      mintUrl?: string;
      timeout: string;
      dryRun: boolean;
      yes: boolean;
    }) => {
      const timeoutMs = Number.parseInt(options.timeout, 10);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        console.error(`Invalid --timeout value: ${options.timeout}`);
        process.exit(1);
      }

      if (!options.dryRun && !options.yes) {
        const rl = require("readline").createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            "This asks every mint whether our ready and inflight proofs are spent, and marks the spent ones as spent locally, reclaiming their balance. Continue? [y/N] ",
            (value: string) => {
              rl.close();
              resolve(value.trim().toLowerCase());
            },
          );
        });
        if (answer !== "y" && answer !== "yes") {
          console.log("Aborted.");
          return;
        }
      }

      try {
        await ensureDaemonRunning();

        const result = await callDaemon("/wallet/check-proofs", {
          method: "POST",
          body: {
            mintUrl: options.mintUrl,
            dryRun: options.dryRun === true,
            timeoutMs,
          },
        });

        if (result.error) {
          console.log(result.error);
          process.exit(1);
        }

        const output = result.output as
          | {
              dryRun?: boolean;
              checked?: number;
              spent?: number;
              spentAmount?: number;
              markedSpent?: number;
              unspent?: number;
              unresolved?: number;
              unreachableMints?: string[];
              mints?: Array<{
                mintUrl: string;
                checked: number;
                checkedAmount: number;
                spent: number;
                spentAmount: number;
                markedSpent: number;
                unspent: number;
                unresolved: number;
                error?: string;
              }>;
            }
          | undefined;

        if (output) {
          for (const mint of output.mints ?? []) {
            console.log(`\n${mint.mintUrl}`);
            if (mint.error) {
              console.log(`  unreachable: ${mint.error}`);
              continue;
            }
            console.log(
              `  checked:    ${mint.checked} (${mint.checkedAmount} sat)`,
            );
            console.log(`  spent:      ${mint.spent} (${mint.spentAmount} sat)`);
            console.log(`  unspent:    ${mint.unspent}`);
            console.log(`  unresolved: ${mint.unresolved}`);
          }

          console.log(output.dryRun ? "\nWould mark as spent:" : "\nMarked as spent:");
          console.log(
            `  proofs: ${output.markedSpent ?? 0} of ${output.spent ?? 0} the mints report spent`,
          );
          console.log(
            `  sats ${output.dryRun ? "reclaimable" : "reclaimed"}: ${output.spentAmount ?? 0}`,
          );
          console.log(
            `  examined: ${output.checked ?? 0} (unspent ${output.unspent ?? 0}, unresolved ${output.unresolved ?? 0})`,
          );
          const unreachable = output.unreachableMints ?? [];
          if (unreachable.length > 0) {
            console.log(`  unreachable mints: ${unreachable.join(", ")}`);
          }
        }
      } catch (error) {
        const message = (error as Error).message;
        if (
          message?.includes("fetch failed") ||
          message?.includes("Connection refused")
        ) {
          console.error("Daemon is not running");
          process.exit(1);
        }
        console.error(message);
        process.exit(1);
      }
    },
  );

walletCmd
  .command("recover")
  .description(
    "Retry mint quotes using their stored outputs (does not replace rejected outputs)",
  )
  .option(
    "--op <id>",
    "Recover this operation id (repeatable; find IDs with routstrd history --json)",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option(
    "--include-failed",
    "Also re-open operations coco already gave up on (requires --op)",
    false,
  )
  .option("-y, --yes", "Skip confirmation prompt", false)
  .action(
    async (options: {
      op: string[];
      includeFailed: boolean;
      yes: boolean;
    }) => {
      const operationIds = options.op ?? [];
      if (options.includeFailed && operationIds.length === 0) {
        console.error(
          "--include-failed can only target operations named with --op",
        );
        process.exit(1);
      }

      if (!options.yes) {
        const rl = require("readline").createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const prompt =
          operationIds.length > 0
            ? `Recover ${operationIds.length} mint quote operation(s)? [y/N] `
            : "Check every pending mint quote with its mint and claim any paid sats? [y/N] ";
        const answer = await new Promise<string>((resolve) => {
          rl.question(prompt, (value: string) => {
            rl.close();
            resolve(value.trim().toLowerCase());
          });
        });
        if (answer !== "y" && answer !== "yes") {
          console.log("Aborted.");
          return;
        }
      }

      try {
        await ensureDaemonRunning();

        const result = await callDaemon("/wallet/recover", {
          method: "POST",
          body: {
            operationIds: operationIds.length > 0 ? operationIds : undefined,
            includeFailed: options.includeFailed === true,
          },
        });

        if (result.error) {
          console.log(result.error);
          process.exit(1);
        }

        const output = result.output as
          | {
              checked?: number;
              recovered?: number;
              waiting?: number;
              terminal?: number;
              reopened?: number;
              retryable?: number;
              busy?: number;
              errors?: Array<{ operationId: string; error: string }>;
            }
          | undefined;

        if (output) {
          console.log("Mint quote recovery:");
          console.log(`  Checked with mint: ${output.checked ?? 0}`);
          console.log(
            `  Recovered (paid sats claimed): ${output.recovered ?? 0}`,
          );
          console.log(`  Still unpaid: ${output.waiting ?? 0}`);
          console.log(`  No longer issuable: ${output.terminal ?? 0}`);
          console.log(
            `  Re-opened failed operations: ${output.reopened ?? 0}`,
          );
          console.log(`  Left for a later run: ${output.retryable ?? 0}`);
          console.log(
            `  Skipped (recovery still running): ${output.busy ?? 0}`,
          );
          if (output.errors && output.errors.length > 0) {
            console.log("\nErrors:");
            for (const e of output.errors) {
              console.log(`  - ${e.operationId}: ${e.error}`);
            }
          }
        }
      } catch (error) {
        const message = (error as Error).message;
        if (
          message?.includes("fetch failed") ||
          message?.includes("Connection refused")
        ) {
          console.error("Daemon is not running");
          process.exit(1);
        }
        console.error(message);
        process.exit(1);
      }
    },
  );

const walletReceiveCmd = walletCmd
  .command("receive")
  .description("Wallet receive operations");

walletReceiveCmd
  .command("cashu <token>")
  .description("Receive a Cashu token")
  .action(async (token: string) => {
    await warnIfWalletRecovering();
    await handleDaemonCommand("/wallet/receive/cashu", {
      method: "POST",
      body: { token },
    });
  });

walletReceiveCmd
  .command("bolt11 <amount>")
  .description("Create a Lightning invoice")
  .option("--mint-url <url>", "Mint URL to use")
  .action(async (amount: string, options: { mintUrl?: string }) => {
    await warnIfWalletRecovering();
    try {
      await ensureDaemonRunning();

      const result = await callDaemon("/wallet/receive/bolt11", {
        method: "POST",
        body: {
          amount: parsePositiveIntOrExit(amount, "amount"),
          mintUrl: options.mintUrl,
        },
      });

      const output = result.output as
        | { invoice?: string; amount?: number; mintUrl?: string }
        | undefined;

      if (typeof output?.invoice === "string" && output.invoice) {
        await printLightningInvoice(output.invoice);
        return;
      }

      if (result.output !== undefined) {
        console.log(JSON.stringify(result.output, null, 2));
      }
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
  });

const walletSendCmd = walletCmd
  .command("send")
  .description("Wallet send operations");

walletSendCmd
  .command("cashu <amount>")
  .description("Create a Cashu token to send")
  .option("--mint-url <url>", "Mint URL to use")
  .option(
    "--offline",
    "Send the closest available proofs without a swap; finalize manually",
    false,
  )
  .option(
    "--overpay-cap [factor]",
    "With --offline, allow a token worth up to FACTOR x the amount (default 3) before falling back to an online send",
  )
  .action(
    async (
      amount: string,
      options: { mintUrl?: string; offline: boolean; overpayCap?: string | boolean },
    ) => {
      await warnIfWalletRecovering();
      const overpayCap = parseOverpayCapOrExit(options.overpayCap);
      if (overpayCap !== undefined && !options.offline) {
        console.error("--overpay-cap requires --offline");
        process.exit(1);
      }
      await handleDaemonCommand("/wallet/send/cashu", {
        method: "POST",
        body: {
          amount: parsePositiveIntOrExit(amount, "amount"),
          mintUrl: options.mintUrl,
          offline: options.offline,
          ...(overpayCap !== undefined ? { overpayCap } : {}),
        },
      });
    },
  );

walletSendCmd
  .command("mark-spent <operation-id>")
  .description(
    "Mark an offline token's proofs spent locally and finalize it (no mint check)",
  )
  .option("-y, --yes", "Skip irreversible local settlement confirmation", false)
  .action(async (operationId: string, options: { yes: boolean }) => {
    if (!options.yes) {
      if (!process.stdin.isTTY) {
        console.error("mark-spent requires confirmation; use --yes for non-interactive use.");
        process.exitCode = 1;
        return;
      }
      const rl = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question(
          `Mark offline send ${operationId} spent WITHOUT checking the mint? This cannot be undone locally, even if the recipient never claims it. Continue? [y/N] `,
          (value: string) => {
            rl.close();
            resolve(value.trim().toLowerCase());
          },
        );
      });
      if (answer !== "y" && answer !== "yes") {
        console.log("Aborted.");
        return;
      }
    }
    await handleDaemonCommand(
      `/wallet/send/cashu/${encodeURIComponent(operationId)}/mark-spent`,
      { method: "POST" },
    );
  });

walletSendCmd
  .command("bolt11 <invoice>")
  .description("Pay a Lightning invoice")
  .option("--mint-url <url>", "Mint URL to use")
  .action(async (invoice: string, options: { mintUrl?: string }) => {
    await warnIfWalletRecovering();
    await handleDaemonCommand("/wallet/send/bolt11", {
      method: "POST",
      body: {
        invoice,
        mintUrl: options.mintUrl,
      },
    });
  });

const walletMintsCmd = walletCmd
  .command("mints")
  .description("Wallet mint operations");

walletMintsCmd
  .command("list")
  .description("List configured wallet mints")
  .action(async () => {
    await handleDaemonCommand("/wallet/mints");
  });

walletMintsCmd
  .command("add <url>")
  .description("Add a wallet mint")
  .action(async (url: string) => {
    await handleDaemonCommand("/wallet/mints", {
      method: "POST",
      body: { url },
    });
  });

walletMintsCmd
  .command("info <url>")
  .description("Get wallet mint info")
  .action(async (url: string) => {
    await handleDaemonCommand("/wallet/mints/info", {
      method: "POST",
      body: { url },
    });
  });

walletMintsCmd
  .command("set-default <url>")
  .description("Set the default mint for wallet operations")
  .action(async (url: string) => {
    await handleDaemonCommand("/wallet/mints/default", {
      method: "POST",
      body: { url },
    });
  });

const walletNpcCmd = walletCmd
  .command("npc")
  .description("NPC (npubx.cash) Lightning address operations");

walletNpcCmd
  .command("address")
  .description("Show this wallet's NPC Lightning address")
  .action(async () => {
    await handleDaemonCommand("/wallet/npc/address");
  });

walletNpcCmd
  .command("username <name>")
  .description(
    "Claim an NPC username (pays the claim fee from the wallet with --confirm)",
  )
  .option("--confirm", "Confirm payment of the username claim fee")
  .action(async (name: string, options: { confirm?: boolean }) => {
    await handleDaemonCommand("/wallet/npc/username", {
      method: "POST",
      body: { username: name, confirm: options.confirm === true },
    });
  });

walletNpcCmd
  .command("sync")
  .description("Manually sync paid NPC quotes into the wallet")
  .action(async () => {
    await handleDaemonCommand("/wallet/npc/sync", { method: "POST" });
  });

// ── NWC (Nostr Wallet Connect) commands ─────────────────────────

const nwcCmd = program
  .command("nwc")
  .description("Manage NWC (Nostr Wallet Connect) integration");

nwcCmd
  .command("connect")
  .description("Connect to a Lightning wallet via NWC")
  .argument("[connection-string]", "NWC connection string (nostr+walletconnect://...)")
  .action(async (connectionString?: string) => {
    if (!connectionString) {
      // Interactive mode: prompt for connection string
      const rl = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      connectionString = await new Promise<string>((resolve) => {
        rl.question("Paste your NWC connection string: ", (answer: string) => {
          rl.close();
          resolve(answer.trim());
        });
      });
    }

    // Quick validation: must be nostr+walletconnect:// with a 64-char hex pubkey
    if (!/^nostr\+walletconnect:\/\/[0-9a-fA-F]{64}\?relay=/.test(connectionString)) {
      console.error("Invalid NWC connection string: expected nostr+walletconnect://<64-char-hex>?relay=...");
      process.exit(1);
    }

    await handleDaemonCommand("/nwc/connect", {
      method: "POST",
      body: { connectionString },
    });
  });

nwcCmd
  .command("disconnect")
  .description("Disconnect from NWC wallet")
  .action(async () => {
    await handleDaemonCommand("/nwc/disconnect", {
      method: "POST",
    });
  });

nwcCmd
  .command("status")
  .description("Show NWC connection status and wallet info")
  .action(async () => {
    await handleDaemonCommand("/nwc/status");
  });

nwcCmd
  .command("fund <amount>")
  .description("Manually fund the Cashu wallet from the connected NWC wallet")
  .action(async (amount: string) => {
    const parsedAmount = parsePositiveIntOrExit(amount, "amount");
    await handleDaemonCommand("/nwc/fund", {
      method: "POST",
      body: { amount: parsedAmount },
    });
  });

const autoRefillCmd = nwcCmd
  .command("auto-refill")
  .description("Manage automatic wallet refill from NWC");

autoRefillCmd
  .command("on")
  .description("Enable auto-refill")
  .option(
    "--threshold <sats>",
    "Refill when Cashu balance drops below this many sats",
    "500",
  )
  .option("--amount <sats>", "Refill this many sats at a time", "1000")
  .option(
    "--cooldown <seconds>",
    "Minimum time between refills in seconds",
    "300",
  )
  .action(async (options: { threshold: string; amount: string; cooldown: string }) => {
    const threshold = parsePositiveIntOrExit(options.threshold, "threshold");
    const amount = parsePositiveIntOrExit(options.amount, "amount");
    const cooldownSec = parsePositiveIntOrExit(options.cooldown, "cooldown");

    await handleDaemonCommand("/nwc/auto-refill", {
      method: "POST",
      body: {
        enabled: true,
        threshold,
        amount,
        cooldownMs: cooldownSec * 1000,
      },
    });
  });

autoRefillCmd
  .command("off")
  .description("Disable auto-refill")
  .action(async () => {
    await handleDaemonCommand("/nwc/auto-refill", {
      method: "POST",
      body: { enabled: false },
    });
  });

// Stop
program
  .command("stop")
  .description("Stop the background daemon")
  .action(async () => {
    if (!(await isDaemonRunning())) {
      console.log("Daemon was not running.");
      return;
    }
    await callDaemon("/stop", { method: "POST" });

    // The daemon exits only after ongoing requests finish; wait for it so
    // the wallet lock is actually free when this command returns.
    try {
      await waitForDaemonToExit({ pidFilePath: walletPidPath() });
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    console.log("Daemon stopped.");
  });

// Service - PM2 management
const serviceCmd = program
  .command("service")
  .description("Manage routstrd as a system service using PM2");

serviceCmd
  .command("install")
  .description("Install and start routstrd using PM2 for persistence")
  .action(async () => {
    await requireLocalDaemon();
    // 1. Check if PM2 is installed
    try {
      execSync("pm2 -v", { stdio: "ignore" });
    } catch (e) {
      if (isStandaloneExecutable()) {
        console.error(
          "PM2 is optional and is not bundled with routstrd. Install PM2 separately before using 'routstrd service install'.",
        );
        process.exit(1);
      }
      console.log("PM2 not found. Installing PM2 globally with bun...");
      try {
        execSync("bun install -g pm2", { stdio: "inherit" });
      } catch (err) {
        console.error(
          "Failed to install PM2. Please install it manually: bun install -g pm2",
        );
        process.exit(1);
      }
    }

    console.log("Starting routstrd via PM2...");
    try {
      await stopLegacyCocod();

      const proc = Bun.spawn(["pm2", ...pm2DaemonArgs()], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await proc.exited) !== 0) throw new Error("PM2 exited with an error");

      console.log("\n✅ routstrd is now managed by PM2.");
      console.log("\nTo ensure it starts on system reboot, run:");
      console.log("  pm2 startup");
      console.log("  pm2 save");
      console.log("\nTo view logs:");
      console.log("  pm2 logs routstrd");
    } catch (err) {
      console.error("Failed to start routstrd via PM2.");
      process.exit(1);
    }
  });

serviceCmd
  .command("uninstall")
  .description("Stop and remove routstrd from PM2")
  .action(() => {
    try {
      execSync("pm2 delete routstrd", { stdio: "inherit" });
      console.log("✅ routstrd service removed from PM2.");
    } catch (e) {
      console.error(
        "Failed to remove service. It might not be running in PM2.",
      );
    }
  });

serviceCmd
  .command("logs")
  .description("View PM2 logs for routstrd")
  .action(() => {
    try {
      execSync("pm2 logs routstrd", { stdio: "inherit" });
    } catch (e) {
      // Ignored
    }
  });

// Restart
program
  .command("restart")
  .description("Restart the background daemon")
  .option("--port <port>", "Port to listen on")
  .option("--host <host>", "Bind address (default: 127.0.0.1)")
  .option("-p, --provider <provider>", "Default provider to use")
  .action(async (options: { port?: string; host?: string; provider?: string }) => {
    await requireLocalDaemon();
    await maybePromptForUpdate();
    const config = await loadConfig();
    await restartLocalDaemon(config, options);
    console.log("Daemon restarted.");
  });

// Mode
program
  .command("mode")
  .description("Set the client mode (lazyrefund/apikeys or xcashu)")
  .action(async () => {
    await requireLocalDaemon();
    const config = await loadConfig();
    const currentMode = config.mode || "apikeys";

    console.log("Select client mode:");
    console.log(
      "  1) lazyrefund/apikeys    - Pseudonymous accounts are kept with the Routstr nodes and are refunded after 5 mins if not used.",
    );
    console.log(
      "  2) xcashu (coming soon)   - Balances are never kept with the nodes, all balances are refunded in response.",
    );
    console.log(`\nCurrent mode: ${currentMode}`);

    const modes: Array<"apikeys" | "xcashu"> = ["apikeys", "xcashu"];

    const selectedIndex = await new Promise<number>((resolve) => {
      const rl = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question("\nEnter choice (1-2): ", (answer: string) => {
        rl.close();
        const num = parseInt(answer, 10);
        resolve(Number.isFinite(num) && num >= 1 && num <= 2 ? num - 1 : 0);
      });
    });

    const selectedMode = modes[selectedIndex];

    if (selectedMode === "xcashu") {
      console.log(
        "\nxcashu mode is coming soon! Only lazyrefund/apikeys is available at this time.",
      );
      return;
    }

    if (selectedMode === currentMode) {
      console.log(`Mode is already set to '${selectedMode}'. No changes made.`);
      return;
    }

    // Update config
    const updatedConfig: RoutstrdConfig = {
      ...config,
      mode: selectedMode,
    };
    saveDaemonConfig(updatedConfig);
    console.log(`Mode set to '${selectedMode}'. Restarting daemon...`);

    await restartLocalDaemon(config);
    console.log(`Daemon restarted with mode '${selectedMode}'.`);
  });

// Logs
/**
 * How long after local midnight `logs` keeps showing yesterday's file too.
 * Long enough to cover `tail -n 7` of daemon activity across the boundary,
 * short enough that ordinary daytime output is a single date's file.
 */
const MIDNIGHT_GRACE_MS = 60 * 60 * 1000;

function getLogFileForDate(logsDir: string, date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${logsDir}/${year}-${month}-${day}.log`;
}

function readAllLines(file: string): string[] {
  const content = readFileSync(file, "utf8");
  const allLines = content.replace(/\r\n/g, "\n").split("\n");
  if (allLines.at(-1) === "") allLines.pop();
  return allLines;
}

function readLastLines(file: string, lines: number): string {
  return readAllLines(file).slice(-lines).join("\n");
}

async function followLogFile(file: string, lines: number): Promise<void> {
  const initial = readLastLines(file, lines);
  if (initial) {
    console.log(initial);
  }

  let position = statSync(file).size;
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!existsSync(file)) {
      continue;
    }

    const size = statSync(file).size;
    if (size < position) {
      position = 0;
    }
    if (size === position) {
      continue;
    }

    const text = await Bun.file(file).slice(position, size).text();
    process.stdout.write(text);
    position = size;
  }
}

type StructuredLogLine = {
  timestamp?: string;
  level?: string;
  requestId?: string;
  modelId?: string;
  isRouting: boolean;
};

export function parseStructuredLogLine(line: string): StructuredLogLine {
  const out: StructuredLogLine = { isRouting: false };

  const head = line.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]/);
  if (head) {
    out.timestamp = head[1];
    out.level = head[2];
  }

  // Request ids are hex (no colons). Stop at the first ':' so legacy
  // colon-joined child tags like `[req:2c30d5ed:RoutstrClient]` still yield
  // the bare request id.
  const req = line.match(/\[req:([^\]\:]+)/);
  if (req) {
    out.requestId = req[1]!.trim();
  }

  // Prefer an explicit `[model:...]` tag; fall back to the modelId embedded
  // in the SDK's `generic request pricing input {"modelId":"..."}` line.
  const model = line.match(/\[model:([^\]\:]+)\]/);
  if (model) {
    out.modelId = model[1]!.trim();
  } else {
    const jsonModel = line.match(/"modelId"\s*:\s*"([^"]+)"/);
    if (jsonModel) {
      out.modelId = jsonModel[1];
    }
  }

  out.isRouting = !!out.requestId && line.includes("Routing request with path");
  return out;
}

type RequestSummary = {
  requestId: string;
  modelId: string;
  timestamp?: string;
};

/**
 * Scan log lines newest-first and collect one record per request, keyed off
 * the "Routing request with path" line (the canonical per-request entry).
 * The model is enriched in a second pass from any line belonging to the
 * request (the SDK pricing line embeds modelId even in legacy logs).
 */
export function collectRecentRequestsFromLines(
  lines: string[],
  limit: number,
): RequestSummary[] {
  const result: RequestSummary[] = [];
  const seen = new Set<string>();

  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseStructuredLogLine(lines[i]!);
    if (!parsed.isRouting || !parsed.requestId) continue;
    if (seen.has(parsed.requestId)) continue;
    seen.add(parsed.requestId);

    result.push({
      requestId: parsed.requestId,
      modelId: parsed.modelId ?? "unknown",
      timestamp: parsed.timestamp,
    });

    if (result.length >= limit) break;
  }

  // Second pass: fill in the model for requests whose routing line predates
  // the `[model:...]` tag but which logged `{"modelId":"..."}` later on.
  const byRequestId = new Map(result.map((r) => [r.requestId, r]));
  for (const line of lines) {
    const parsed = parseStructuredLogLine(line);
    if (!parsed.requestId || !parsed.modelId) continue;
    const record = byRequestId.get(parsed.requestId);
    if (record && record.modelId === "unknown") {
      record.modelId = parsed.modelId;
    }
  }

  return result;
}

function collectRecentRequests(
  files: string[],
  limit: number,
): RequestSummary[] {
  const result: RequestSummary[] = [];
  const seen = new Set<string>();

  // Files are passed oldest-first (yesterday, today); scan newest-first.
  for (const file of [...files].reverse()) {
    if (!existsSync(file)) continue;
    const remaining = limit - result.length;
    if (remaining <= 0) break;

    for (const request of collectRecentRequestsFromLines(
      readAllLines(file),
      remaining,
    )) {
      if (seen.has(request.requestId)) continue;
      seen.add(request.requestId);
      result.push(request);
      if (result.length >= limit) return result;
    }
  }

  return result;
}

function filterLinesByRequestId(
  files: string[],
  requestId: string,
): string[] {
  const matches: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readAllLines(file)) {
      if (parseStructuredLogLine(line).requestId === requestId) {
        matches.push(line);
      }
    }
  }
  return matches;
}

function parseLinesOption(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
}


program
  .command("logs")
  .description("View request lifecycle summaries (use --raw for legacy daemon logs)")
  .option("-f, --follow", "Follow requests; emit updated summaries as attempts complete", false)
  .option("-v, --verbose", "Show chronological lifecycle diagnostics and correlated safe log lines", false)
  .option("--raw", "Show legacy flat daemon logs (may contain sensitive diagnostics)", false)
  .option("--before <timestamp>", "Requests started before epoch milliseconds")
  .option("--after <timestamp>", "Requests started after epoch milliseconds")
  .option("--outcome <outcome>", "Filter by lifecycle outcome")
  .option("--model-id <id>", "Filter by requested canonical model")
  .option("--base-url <url>", "Filter by provider URL")
  .option("--client-id <id>", "Filter by client ID")
  .option("-c, --coco", "Show Cashu wallet-engine (coco) logs instead of daemon logs", false)
  .option("-n, --lines <number>", "Number of requests (or lines with --raw) to show", "7")
  .option("-r, --recent", "List recent requests (legacy request index with --raw)", false)
  .option("-i, --request-id <id>", "Only show this lifecycle UUID (log lines with --raw)")
  .action(
    async (options: RequestLogFilters & {
      follow: boolean;
      coco: boolean;
      recent: boolean;
      verbose: boolean;
      raw: boolean;
    }) => {
      await requireLocalDaemon();

      if (options.recent && options.requestId) {
        console.error(
          "Cannot combine --recent (-r) with --request-id (-i).",
        );
        process.exit(1);
      }

      const logsDir = options.coco ? COCO_LOGS_DIR : LOGS_DIR;
      const now = new Date();
      const todayFile = getLogFileForDate(logsDir, now);
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayFile = getLogFileForDate(logsDir, yesterday);
      // Daily files are named after the local date of each write (see
      // utils/logger.ts), so plain tail output should normally be today's file
      // only. Right after midnight, though, today's file holds a handful of
      // lines while the interesting tail still sits at the end of yesterday's
      // file, so span the boundary for a short window.
      const justAfterMidnight =
        now.getTime() -
          new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() <
        MIDNIGHT_GRACE_MS;

      if (!options.raw && !options.coco) {
        // The daemon reads its persistent lifecycle DB, including failures that
        // never created usage rows. Flat logs cannot supply the status chain.
        const follower = new RequestLogFollower();
        const diagnostics = options.verbose && options.follow ? new IncrementalRequestLogs(LOGS_DIR) : undefined;
        let first = true;
        do {
          const traces = await loadRequestTraces(options, callDaemon);
          const ids = traces.map(trace => trace.request.requestId);
          const poll = diagnostics?.poll(ids);
          for (const warning of poll?.warnings ?? []) console.error(warning);
          const logLines = diagnostics?.diagnostics(ids) ?? (options.verbose && existsSync(LOGS_DIR)
            ? readdirSync(LOGS_DIR).filter(file => /^\d{4}-\d{2}-\d{2}\.log$/.test(file))
                .sort().flatMap(file => readAllLines(join(LOGS_DIR, file)))
            : []);
          const output = follower.changed(traces, options.verbose, logLines);
          for (const rendered of output) console.log(rendered);
          if (first && traces.length === 0) console.log("No requests found.");
          first = false;
          if (!options.follow) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } while (true);
        return;
      }

      if (!existsSync(todayFile) && !existsSync(yesterdayFile)) {
        console.log("No log files found. Daemon may not have started yet.");
        console.log(`Logs directory: ${logsDir}`);
        process.exit(1);
      }

      const lines = parseLinesOption(options.lines);

      // Lookups (--recent, --request-id) reach back a day: a request started
      // before midnight may still be the one being investigated.
      const logFiles = [yesterdayFile, todayFile].filter(
        (file, index, files) =>
          existsSync(file) && files.indexOf(file) === index,
      );
      const tailCandidates = justAfterMidnight
        ? [yesterdayFile, todayFile]
        : [todayFile];
      const existingTailFiles = tailCandidates.filter(
        (file, index, files) =>
          existsSync(file) && files.indexOf(file) === index,
      );
      // The daemon may not have written anything today yet (it was stopped
      // overnight); fall back to the newest file rather than printing nothing.
      const tailFiles = existingTailFiles.length > 0
        ? existingTailFiles
        : logFiles.slice(-1);

      if (options.recent) {
        const requests = collectRecentRequests(logFiles, lines);
        if (requests.length === 0) {
          console.log("No requests found in recent logs.");
          return;
        }

        console.log("Recent requests (newest first):");
        for (const request of requests) {
          const when = request.timestamp
            ? utcTime(Date.parse(request.timestamp))
            : "--:--:--";
          console.log(`${when}  ${request.requestId}  ${request.modelId}`);
        }
        return;
      }

      if (options.requestId) {
        const matches = filterLinesByRequestId(logFiles, options.requestId);
        if (matches.length === 0) {
          console.log(
            `No log lines found for request '${options.requestId}'.`,
          );
          return;
        }

        for (const line of matches) {
          console.log(line);
        }
        return;
      }

      if (options.follow) {
        if (existsSync(todayFile)) {
          await followLogFile(todayFile, lines);
        } else {
          console.log("No log file for today to follow.");
        }
        return;
      }

      for (const file of tailFiles) {
        if (tailFiles.length > 1) {
          console.log(`==> ${file} <==`);
        }
        const output = readLastLines(file, lines);
        if (output) {
          console.log(output);
        }
      }
    },
  );

// After any command, surface the daemon's cached "newer routstrd available"
// notice (balance, send, receive, ...). Commands that manage updates themselves
// or own the terminal are excluded. The notice goes to stderr so stdout stays
// machine-readable.
program.hook("postAction", async (_thisCommand, actionCommand) => {
  if (!actionCommand) return;
  const parent = actionCommand.parent;
  if (parent === program) {
    const name = actionCommand.name();
    if (["update", "daemon", "monitor", "top", "start", "restart", "stop"].includes(name)) {
      return;
    }
  }
  // `service ...` is pm2 plumbing (`service logs` follows forever).
  if (parent?.name() === "service") return;
  await maybeShowUpdateNotice();
});

export function cli(args: string[]) {
  return program.parseAsync(args);
}
