import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { Database } from "bun:sqlite";
import { join } from "path";
import {
  classifyWalletMigration,
  type WalletMigrationClass,
} from "./wallet-state";

/**
 * Wallet diagnostics for the cocod → routstrd wallet-directory migration.
 *
 * The migration in `migration.ts` refuses to choose between two wallets when
 * both `~/.routstrd/wallet` and `~/.cocod` contain different data. These
 * helpers summarize each side with privacy-safe, decision-relevant signals
 * (mnemonic fingerprint, timestamps, and database proof/amount summaries) so a
 * user can tell which wallet is the real one without us ever printing secrets.
 */

export type WalletRole = "canonical" | "legacy";

export type WalletSummary = Record<string, unknown[]>;

/** Queries shared with the migration snapshot verifier. */
export const SUMMARY_QUERIES: Record<string, string> = {
  proofs:
    "SELECT mintUrl, state, COUNT(*) count, COALESCE(SUM(amount), 0) amount FROM coco_cashu_proofs GROUP BY mintUrl, state ORDER BY mintUrl, state",
  counters:
    "SELECT mintUrl, keysetId, counter FROM coco_cashu_counters ORDER BY mintUrl, keysetId",
  mintOperations:
    "SELECT state, COUNT(*) count FROM coco_cashu_mint_operations GROUP BY state ORDER BY state",
  sendOperations:
    "SELECT state, COUNT(*) count FROM coco_cashu_send_operations GROUP BY state ORDER BY state",
  meltOperations:
    "SELECT state, COUNT(*) count FROM coco_cashu_melt_operations GROUP BY state ORDER BY state",
  mints: "SELECT mintUrl, trusted FROM coco_cashu_mints ORDER BY mintUrl",
};

/**
 * Verify a database is healthy and return a wallet summary. Throws on corrupt
 * databases because the migration must never proceed over them.
 */
export function verifyDatabase(database: Database, label: string): WalletSummary {
  const checks = database.query("PRAGMA quick_check").values() as unknown[][];
  if (checks.length !== 1 || checks[0]?.[0] !== "ok") {
    throw new Error(`${label} failed PRAGMA quick_check: ${JSON.stringify(checks)}`);
  }

  const tables = new Set(
    (database
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .values() as string[][]).map(([name]) => name),
  );
  const summary: WalletSummary = {};
  for (const [name, query] of Object.entries(SUMMARY_QUERIES)) {
    const table = query.match(/FROM\s+(coco_cashu_\w+)/i)?.[1];
    summary[name] = table && tables.has(table) ? database.query(query).all() : [];
  }
  return summary;
}

export interface ProofSummaryRow {
  mintUrl: string;
  state: string;
  count: number;
  amount: number;
}

export interface DbDiagnosticSummary {
  proofs: ProofSummaryRow[];
  mints: { mintUrl: string; trusted: number }[];
  totalProofs: number;
  totalAmount: number;
  amountByState: Record<string, number>;
  distinctMints: number;
}

export interface WalletConfigDiagnostic {
  exists: boolean;
  path: string;
  mtimeMs?: number;
  error?: string;
  fingerprint?: string;
  encrypted?: boolean;
  createdAt?: string;
  version?: number;
  defaultMintUrl?: string;
  hasMnemonic?: boolean;
}

export interface WalletDbDiagnostic {
  exists: boolean;
  path: string;
  mtimeMs?: number;
  sizeBytes?: number;
  error?: string;
  summary?: DbDiagnosticSummary;
}

export interface WalletDiagnostic {
  dir: string;
  role: WalletRole;
  config: WalletConfigDiagnostic;
  db: WalletDbDiagnostic;
}

/** A one-way, truncated fingerprint of a mnemonic. Never returns the mnemonic. */
export function mnemonicFingerprint(mnemonic: string): string {
  const normalized = mnemonic.trim().split(/\s+/).join(" ");
  const hex = createHash("sha256").update(normalized).digest("hex");
  return hex.slice(0, 16).match(/.{1,4}/g)?.join("-") ?? hex.slice(0, 16);
}

/** Read-only DB summary; never throws, degrades to an error string. */
export function summarizeDbReadonly(
  dbPath: string,
): { summary?: DbDiagnosticSummary; error?: string } {
  let database: Database | undefined;
  try {
    database = new Database(dbPath, { readonly: true });
    const raw = verifyDatabase(database, "Wallet database");

    const proofs = (raw.proofs ?? []) as ProofSummaryRow[];
    const mints = (raw.mints ?? []) as { mintUrl: string; trusted: number }[];
    const amountByState: Record<string, number> = {};
    let totalProofs = 0;
    let totalAmount = 0;
    for (const row of proofs) {
      const count = typeof row.count === "number" ? row.count : 0;
      const amount = typeof row.amount === "number" ? row.amount : 0;
      totalProofs += count;
      totalAmount += amount;
      const state = row.state || "unknown";
      amountByState[state] = (amountByState[state] ?? 0) + amount;
    }

    return {
      summary: {
        proofs,
        mints,
        totalProofs,
        totalAmount,
        amountByState,
        distinctMints: new Set(proofs.map((row) => row.mintUrl).filter(Boolean)).size,
      },
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    database?.close();
  }
}

function summarizeConfig(configPath: string): WalletConfigDiagnostic {
  const result: WalletConfigDiagnostic = { exists: false, path: configPath };
  try {
    if (!existsSync(configPath)) return result;
    result.exists = true;
    result.mtimeMs = statSync(configPath).mtimeMs;

    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    result.encrypted = parsed.encrypted === true;
    if (typeof parsed.createdAt === "string") result.createdAt = parsed.createdAt;
    if (typeof parsed.version === "number") result.version = parsed.version;
    if (typeof parsed.defaultMintUrl === "string") {
      result.defaultMintUrl = parsed.defaultMintUrl;
    }
    if (typeof parsed.mnemonic === "string") {
      result.hasMnemonic = true;
      if (!result.encrypted) result.fingerprint = mnemonicFingerprint(parsed.mnemonic);
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function summarizeDb(dbPath: string): WalletDbDiagnostic {
  const result: WalletDbDiagnostic = { exists: false, path: dbPath };
  try {
    if (!existsSync(dbPath)) return result;
    result.exists = true;
    const stats = statSync(dbPath);
    result.mtimeMs = stats.mtimeMs;
    result.sizeBytes = stats.size;

    const { summary, error } = summarizeDbReadonly(dbPath);
    if (summary) result.summary = summary;
    if (error) result.error = error;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export function summarizeWalletDirectory(
  dir: string,
  role: WalletRole,
): WalletDiagnostic {
  return {
    dir,
    role,
    config: summarizeConfig(join(dir, "config.json")),
    db: summarizeDb(join(dir, "coco.db")),
  };
}

export class WalletMigrationConflictError extends Error {
  readonly target: WalletDiagnostic;
  readonly source: WalletDiagnostic;

  constructor(target: WalletDiagnostic, source: WalletDiagnostic) {
    super(renderWalletConflict(target, source));
    this.name = "WalletMigrationConflictError";
    this.target = target;
    this.source = source;
  }
}

function timeAgo(ms?: number): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const elapsed = Date.now() - ms;
  if (elapsed < 0) return undefined;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function modifiedDescription(config: WalletConfigDiagnostic): string {
  if (config.createdAt) return `created ${config.createdAt}`;
  const ago = timeAgo(config.mtimeMs);
  if (ago) return `modified ${ago}`;
  return "modified time unknown";
}

function roleLabel(role: WalletRole): string {
  return role === "canonical" ? "current routstrd wallet" : "legacy cocod wallet";
}

function configLine(config: WalletConfigDiagnostic): string {
  if (!config.exists) return "config.json  absent";
  if (config.error) return `config.json  present (unreadable: ${config.error})`;
  const parts: string[] = ["config.json  present"];
  if (config.fingerprint) parts.push(`fingerprint ${config.fingerprint}`);
  else if (config.encrypted) parts.push("encrypted (mnemonic not readable)");
  else parts.push("no mnemonic found");
  parts.push(modifiedDescription(config));
  if (config.defaultMintUrl) parts.push(`default mint ${config.defaultMintUrl}`);
  return parts.join(" · ");
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function amountByStateLine(summary: DbDiagnosticSummary): string {
  const parts = Object.entries(summary.amountByState).filter(([, amount]) => amount > 0);
  if (parts.length === 0) return "0 sats";
  return parts.map(([state, amount]) => `${state}: ${formatNumber(amount)} sats`).join(", ");
}

function dbLine(db: WalletDbDiagnostic): string {
  if (!db.exists) return "coco.db     absent";
  if (db.error && !db.summary) return `coco.db     present (unreadable: ${db.error})`;
  const parts: string[] = ["coco.db     present"];
  if (db.summary) {
    const { totalProofs, mints, distinctMints } = db.summary;
    // The mints table is the wallet's mint registry; fall back to mints seen
    // in proofs for databases old enough to lack the registry table.
    const mintCount = mints.length > 0 ? mints.length : distinctMints;
    parts.push(`${formatNumber(totalProofs)} proof${totalProofs === 1 ? "" : "s"}`);
    parts.push(amountByStateLine(db.summary));
    parts.push(`${mintCount} mint${mintCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function block(diag: WalletDiagnostic, letter: string): string {
  return [
    `  ${letter}) ${diag.dir} (${roleLabel(diag.role)})`,
    `     ${configLine(diag.config)}`,
    `     ${dbLine(diag.db)}`,
  ].join("\n");
}

function moveAsideCommands(target: WalletDiagnostic, source: WalletDiagnostic): string {
  return [
    "  • If B is your wallet (keep the legacy wallet):",
    `      mv "${target.dir}" "${target.dir}.old"`,
    "",
    "  • If A is your wallet (keep the normal routstrd wallet):",
    `      mv "${source.dir}" "${source.dir}.old"`,
  ].join("\n");
}

export function renderResolutionSteps(
  target: WalletDiagnostic,
  source: WalletDiagnostic,
): string {
  return [
    "To resolve, decide which wallet is yours, move the other one aside, and run",
    "'routstrd onboard' (or 'routstrd start') again. Stop the daemon first:",
    "",
    "  routstrd stop",
    "",
    "Then:",
    "",
    moveAsideCommands(target, source),
  ].join("\n");
}

export function renderWalletConflict(
  target: WalletDiagnostic,
  source: WalletDiagnostic,
): string {
  return [
    "Cannot migrate wallet: two different wallets were found, and routstrd will",
    "not choose a mnemonic or merge databases automatically — the wrong choice",
    "could lose access to your funds.",
    "",
    block(target, "A"),
    block(source, "B"),
    "",
    "No files were changed.",
    "",
    renderResolutionSteps(target, source),
    "",
    "For a full comparison and safe cleanup, run: routstrd wallet doctor",
  ].join("\n");
}

export interface WalletVerdict {
  /** One-line human verdict for the doctor report. */
  text: string;
  /** Whether the mv-aside resolution steps apply to this state. */
  showResolution: boolean;
  /** Whether startup would (or may) refuse to migrate in this state. */
  conflict: boolean;
}

function conflictVerdict(
  target: WalletDiagnostic,
  source: WalletDiagnostic,
): WalletVerdict {
  const unreadable =
    !!target.config.error ||
    !!source.config.error ||
    !!target.db.error ||
    !!source.db.error;
  if (unreadable) {
    return {
      text: "Verdict: both wallets exist but one or both could not be fully read; startup will refuse to migrate. See the details above.",
      showResolution: true,
      conflict: true,
    };
  }
  if (target.config.fingerprint && source.config.fingerprint) {
    if (target.config.fingerprint === source.config.fingerprint) {
      return {
        text: "Verdict: both wallets share the same mnemonic but the files differ, so startup still refuses. Keep the wallet with your funds and move the other aside.",
        showResolution: true,
        conflict: true,
      };
    }
    return {
      text: "Verdict: the two wallets have DIFFERENT mnemonics. Startup will refuse to migrate.",
      showResolution: true,
      conflict: true,
    };
  }
  return {
    text: "Verdict: both wallets exist but their mnemonics cannot be compared (encrypted or missing). Startup will refuse to migrate unless the files are identical.",
    showResolution: true,
    conflict: true,
  };
}

function verdictFromClassification(
  target: WalletDiagnostic,
  source: WalletDiagnostic,
  classification: WalletMigrationClass,
): WalletVerdict {
  switch (classification.kind) {
    case "fresh":
      return {
        text: "Verdict: no wallet found in either location (fresh install).",
        showResolution: false,
        conflict: false,
      };
    case "already-current":
      return {
        text: "Verdict: the current routstrd wallet is authoritative; no migration needed.",
        showResolution: false,
        conflict: false,
      };
    case "migrate":
      return {
        text: "Verdict: only the legacy cocod wallet exists; it will be migrated on next startup.",
        showResolution: false,
        conflict: false,
      };
    case "conflict":
      return conflictVerdict(target, source);
    case "database-only":
      return {
        text: "Verdict: a wallet is incomplete (coco.db without config.json). Startup will refuse to migrate. See the details above.",
        showResolution: false,
        conflict: true,
      };
    case "orphaned-sidecars":
      return {
        text: "Verdict: the legacy wallet has SQLite sidecar files without coco.db. Startup will refuse to migrate. Restore the matching database first.",
        showResolution: false,
        conflict: true,
      };
  }
}

/** Map the shared migration classification onto a human doctor verdict. */
export function diagnoseWallets(
  target: WalletDiagnostic,
  source: WalletDiagnostic,
): WalletVerdict {
  return verdictFromClassification(
    target,
    source,
    classifyWalletMigration(target.dir, source.dir),
  );
}

export function renderWalletDoctor(
  target: WalletDiagnostic,
  source: WalletDiagnostic,
): string {
  const verdict = diagnoseWallets(target, source);
  const lines = [
    "Routstr wallet diagnostic",
    "========================",
    "",
    block(target, "A"),
    block(source, "B"),
    "",
    verdict.text,
  ];
  if (verdict.showResolution) {
    lines.push("", renderResolutionSteps(target, source));
  }
  return lines.join("\n");
}