#!/usr/bin/env bun
/**
 * recent-sessions.ts — show the pi sessions you used most recently, with the
 * total routstr spend for each one.
 *
 * Spend is not in the pi session file: pi stores token usage but no price
 * (`usage.cost.total` is always 0, because the `routstr` provider in
 * `~/.pi/agent/models.json` carries no pricing table). The price lives in the
 * daemon's response logs, in the SSE line routstr appends before `[DONE]`:
 *
 *   data: {"cost": {"total_msats": 221, "charged_msats": 221,
 *                   "total_usd": 0.00018576, "sats_cost": 0, ...}}
 *
 * So this script joins the two the same way `link-session-logs.ts` does:
 * each assistant message stores the upstream `responseId`, that id appears in
 * `responses/<id>.jsonl`, and the cost line is in that same file. Summing the
 * cost of every response log a session points at gives the session's spend.
 *
 * Both the ids and the cost live inside the JSON-escaped SSE payload of the
 * log (`\"id\":\"gen-…\"`), so the scanner's regexes tolerate the escaping
 * and read the raw file in one pass instead of JSON-parsing every chunk line.
 *
 * Usage:
 *   bun scripts/recent-sessions.ts [--limit N] [--project SUBSTR] [--dir PATH]
 *                                  [--all] [--json]
 *
 *   --limit N        How many sessions to show (default 5).
 *   --project SUBSTR Only sessions whose cwd contains SUBSTR.
 *   --dir PATH       Request/response log root. Defaults to $ROUTSTRD_LOG_DIR,
 *                    else `requestResponseLogging.dir` from ~/.routstrd/config.json,
 *                    else ~/.routstrd/request-response-logs.
 *   --all            Scan every response log instead of only the days the
 *                    listed sessions span (slow: every log on disk).
 *   --json           Machine-readable output.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { brotliDecompressSync } from "node:zlib";

const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
const DEFAULT_LOG_DIR = join(homedir(), ".routstrd", "request-response-logs");

/** Upstream generation ids: `"id":"gen-…"` / `"id":"msg_…"` / `"id":"chatcmpl-…"`. */
const ID_RE = /\\?"id\\?"\s*:\s*\\?"([^"\\]+)\\?"/g;
/** Routstr's billing line. The cost object is flat, so this never over-matches. */
const COST_RE = /\\?"cost\\?":\s*(\{[^{}]*\})/g;

interface Session {
  id: string;
  cwd: string;
  /** First user prompt, so a row is recognisable without opening the file. */
  title: string;
  started: string;
  mtime: number;
  turns: number;
  /** Response ids of the turns, for the join against the response logs. */
  ids: Set<string>;
  inputTokens: number;
  outputTokens: number;
  /** Day prefixes (`YYYY-MM-DD`) the session touched, for narrowing the scan. */
  days: Set<string>;
}

interface Spend {
  usd: number;
  msats: number;
  /** Response log stems that contributed, so a retry is never counted twice. */
  logs: string[];
}

interface Row extends Session {
  model: string;
  priced: number;
  spend?: Spend;
}

interface LogIndex {
  /** responseId -> the response log stems that emitted it. */
  byId: Map<string, string[]>;
  /** stem -> what routstr charged for that one request. */
  charge: Map<string, { usd: number; msats: number }>;
}

function resolveLogDir(flag: string | undefined): string {
  if (flag) return flag;
  if (process.env.ROUTSTRD_LOG_DIR) return process.env.ROUTSTRD_LOG_DIR;
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".routstrd", "config.json"), "utf8"));
    const dir: unknown = config?.requestResponseLogging?.dir;
    if (typeof dir === "string" && dir) return dir;
  } catch {
    /* no config, no explicit dir — fall through to the built-in default */
  }
  return DEFAULT_LOG_DIR;
}

function readMaybeCompressed(path: string): string {
  const buf = readFileSync(path);
  if (!path.endsWith(".br")) return buf.toString("utf8");
  try {
    return brotliDecompressSync(buf).toString("utf8");
  } catch {
    return buf.toString("utf8");
  }
}

interface SessionRecord {
  type?: string;
  id?: string;
  cwd?: string;
  timestamp?: string;
  message?: {
    role?: string;
    responseId?: string;
    model?: string;
    responseModel?: string;
    content?: unknown;
    usage?: { input?: number; output?: number };
  };
}

/** Every jsonl session file under the pi sessions root, newest activity first. */
function listSessionFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(SESSIONS_ROOT, entry.name);
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".jsonl")) files.push(join(dir, file));
    }
  }
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/**
 * Just the header record: enough to filter and to label a row. Reading every
 * session file in full costs seconds (828 files, 364 MB), so the full parse
 * only happens for the handful of sessions actually shown.
 */
function peekSession(path: string): { id: string; cwd: string; started: string } {
  for (const line of readFileSync(path, "utf8").split("\n", 5)) {
    if (!line.includes('"type":"session"')) continue;
    try {
      const record = JSON.parse(line) as SessionRecord;
      return { id: record.id ?? "", cwd: record.cwd ?? "", started: record.timestamp ?? "" };
    } catch {
      break;
    }
  }
  return { id: basename(path).slice(0, 36), cwd: "", started: "" };
}

function readSession(path: string): Session | undefined {
  const head = peekSession(path);
  const session: Session = {
    id: head.id,
    cwd: head.cwd,
    title: "",
    started: head.started,
    mtime: statSync(path).mtimeMs,
    turns: 0,
    ids: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    days: new Set([basename(path).slice(0, 10)]),
  };

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"assistant"') && !line.includes('"user"')) continue;
    let record: SessionRecord;
    try {
      record = JSON.parse(line) as SessionRecord;
    } catch {
      continue;
    }
    if (record.type !== "message") continue;
    if (record.message?.role === "user" && !session.title) {
      const content = record.message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part) => (part as { text?: string }).text ?? "").join(" ")
            : "";
      session.title = text.replace(/\s+/g, " ").trim().slice(0, 60);
      continue;
    }
    if (record.message?.role !== "assistant") continue;
    session.turns += 1;
    session.inputTokens += record.message.usage?.input ?? 0;
    session.outputTokens += record.message.usage?.output ?? 0;
    if (record.message.responseId) session.ids.add(record.message.responseId);
    if (record.timestamp) session.days.add(record.timestamp.slice(0, 10));
  }

  return session.turns > 0 ? session : undefined;
}

/** Last routstr cost object in a response log's raw text, if it carries one. */
function lastCost(raw: string): { usd: number; msats: number } | undefined {
  let payload: string | undefined;
  for (const match of raw.matchAll(COST_RE)) payload = match[1];
  if (!payload) return undefined;
  try {
    const cost = JSON.parse(payload.replace(/\\"/g, '"')) as Record<string, unknown>;
    const msats = Number(cost.charged_msats ?? cost.total_msats ?? 0);
    return { usd: Number(cost.total_usd ?? 0) || 0, msats: msats || 0 };
  } catch {
    return undefined;
  }
}

/**
 * Ids this response log emitted, and what routstr charged for it.
 *
 * Both live inside the escaped SSE payload, so the regexes tolerate the `\"`
 * JSON escaping and no per-line JSON.parse is needed — a plain scan of the raw
 * text is ~5x faster and this runs over every log on disk.
 */
function scanResponseLog(path: string, wanted: Set<string>): {
  hits: Set<string>;
  cost?: { usd: number; msats: number };
} {
  const raw = readMaybeCompressed(path);
  const hits = new Set<string>();
  for (const match of raw.matchAll(ID_RE)) {
    const id = match[1]!;
    if (wanted.has(id)) hits.add(id);
  }
  if (hits.size === 0) return { hits };
  return { hits, cost: lastCost(raw) };
}

/** Map every wanted response id to the log that carries it, with its price. */
function priceSessions(sessions: Session[], logsDir: string, scanAll: boolean): LogIndex {
  const byId = new Map<string, string[]>();
  const charge = new Map<string, { usd: number; msats: number }>();
  const responsesDir = join(logsDir, "responses");
  if (!existsSync(responsesDir)) return { byId, charge };

  const wanted = new Set<string>();
  const days = new Set<string>();
  for (const session of sessions) {
    for (const id of session.ids) wanted.add(id);
    for (const day of session.days) days.add(day);
  }
  // A response log is named for the instant the request arrived, a few ms
  // before the assistant message, so a neighbouring day is always in range.
  const prefixes = new Set<string>();
  for (const day of days) {
    const midnight = Date.parse(`${day}T00:00:00Z`);
    for (const offset of [-86_400_000, 0, 86_400_000]) {
      prefixes.add(new Date(midnight + offset).toISOString().slice(0, 10));
    }
  }

  const candidates = readdirSync(responsesDir)
    .filter(
      (file) =>
        (file.endsWith(".jsonl") || file.endsWith(".jsonl.br")) &&
        (scanAll || prefixes.has(file.slice(0, 10))),
    )
    // Newest first: a session's latest turns resolve early, which lets the
    // early exit below cut a long scan short.
    .sort((a, b) => b.localeCompare(a));

  const pending = new Set(wanted);
  for (const file of candidates) {
    if (pending.size === 0) break; // every id in play has been priced
    const { hits, cost } = scanResponseLog(join(responsesDir, file), pending);
    if (hits.size === 0 || !cost) continue;
    const stem = file.replace(/\.jsonl(\.br)?$/, "");
    charge.set(stem, cost);
    for (const id of hits) {
      pending.delete(id);
      byId.set(id, [...(byId.get(id) ?? []), stem]);
    }
  }

  return { byId, charge };
}

function short(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function compactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function localTime(epochMs: number): string {
  // sv-SE formats as "YYYY-MM-DD HH:MM", i.e. ISO-ish in local time.
  return new Date(epochMs).toLocaleString("sv-SE").slice(0, 16);
}

function main(): void {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const valueOf = (name: string, fallback?: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };

  const limit = Number(valueOf("--limit", "5"));
  const project = valueOf("--project");
  const logDir = resolveLogDir(valueOf("--dir"));

  const sessions = listSessionFiles()
    .map((path) => ({ path, head: peekSession(path) }))
    .filter(({ head }) => (project ? head.cwd.includes(project) : true))
    .slice(0, Number.isFinite(limit) ? limit : 5)
    .map(({ path }) => readSession(path))
    .filter((session): session is Session => session !== undefined && session.turns > 0);

  if (sessions.length === 0) {
    console.error(project ? `no sessions match --project ${project}` : `no pi sessions under ${SESSIONS_ROOT}`);
    process.exit(2);
  }

  const index = priceSessions(sessions, logDir, flags.has("--all"));
  const rows: Row[] = sessions.map((session) => {
    const spend = { usd: 0, msats: 0, logs: [] as string[] };
    const seen = new Set<string>();
    let priced = 0;
    for (const id of session.ids) {
      const stems = index.byId.get(id);
      if (!stems) continue;
      priced += 1;
      // One response log is one charge: never bill a retry log twice, even
      // when one session owns several ids from it.
      for (const stem of stems) {
        if (seen.has(stem)) continue;
        seen.add(stem);
        const charge = index.charge.get(stem)!;
        spend.usd += charge.usd;
        spend.msats += charge.msats;
        spend.logs.push(stem);
      }
    }
    return { ...session, model: basename(session.cwd) || "?", priced, spend };
  });

  if (flags.has("--json")) {
    console.log(
      JSON.stringify(
        rows.map((row) => ({
          session: row.id,
          title: row.title,
          cwd: row.cwd,
          started: row.started,
          lastUsed: new Date(row.mtime).toISOString(),
          turns: row.turns,
          pricedTurns: row.priced,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          usd: row.spend?.usd,
          sats: row.spend ? row.spend.msats / 1000 : undefined,
          responseLogs: row.spend?.logs.map((stem) => join(logDir, "responses", `${stem}.jsonl`)),
        })),
        null,
        2,
      ),
    );
    return;
  }

  const total = rows.reduce((sum, row) => sum + (row.spend?.usd ?? 0), 0);
  const totalSats = rows.reduce((sum, row) => sum + (row.spend?.msats ?? 0), 0) / 1000;

  console.log(`recent pi sessions — ${rows.length} shown, logs ${logDir}\n`);
  for (const row of rows) {
    const spend = row.spend && row.spend.logs.length > 0
      ? `$${row.spend.usd.toFixed(4)}  ${(row.spend.msats / 1000).toFixed(2)} sat`
      : "no logs priced (aborted turns, or logging was off)";
    const label = row.title || row.cwd || row.id;
    console.log(`  ${localTime(row.mtime)}  ${short(label, 68)}`);
    console.log(
      `      ${short(row.model, 24).padEnd(24)} ${row.id.slice(0, 8)}  ` +
        `${`${row.priced}/${row.turns} turns`.padEnd(14)} ` +
        `${`${compactTokens(row.inputTokens)}/${compactTokens(row.outputTokens)} tok`.padEnd(16)} ${spend}`,
    );
  }
  console.log(
    `\n  total: $${total.toFixed(4)} (${totalSats.toFixed(2)} sat)` +
      `   ·   turns = priced/total, usd/sat from routstr's cost line in the response logs`,
  );
}

main();
