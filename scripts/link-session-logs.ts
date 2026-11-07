#!/usr/bin/env bun
/**
 * link-session-logs.ts — map a pi session transcript to the routstrd
 * request/response logs it produced.
 *
 * When `requestResponseLogging` is enabled the daemon writes one
 * `requests/<id>.json` and one `responses/<id>.jsonl` per proxied upstream
 * call. A pi session (see `routstrd clients add pi-agent`) records the same
 * calls in its own transcript, under `~/.pi/agent/sessions/<cwd-slug>/*.jsonl`.
 *
 * The two are written by different processes, so there is no session id on the
 * log side and no log id on the session side — but each assistant message in
 * the session stores the upstream response id (`message.responseId`), and that
 * same id appears verbatim inside the response log's SSE chunks. The request
 * and response logs then share one id (`requests/<id>.json` ↔
 * `responses/<id>.jsonl`, `id` == `requestLogId`), so a response hit yields the
 * request too.
 *
 * Usage:
 *   bun scripts/link-session-logs.ts <session.jsonl> [logsDir] [--all] [--json]
 *
 *   logsDir   Request/response log root. Defaults to $ROUTSTRD_LOG_DIR, else
 *             ~/.routstrd/request-response-logs. On redtop it is
 *             /home/user/.routstrd/reqRes (see requestResponseLogging.dir).
 *   --all     Scan every response log instead of only the session's UTC day
 *             (slower; use when a session spans midnight or logs were rotated).
 *   --json    Emit machine-readable JSON instead of a table.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { brotliDecompressSync } from "node:zlib";

const ID_RE = /"id"\s*:\s*"([^"]+)"/g;

interface Turn {
  /** ISO timestamp of the assistant message (also when the request fired). */
  timestamp: string;
  responseId?: string;
  model?: string;
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

/** Upstream generation ids emitted inside a response log's SSE chunks. */
function responseIds(path: string): Set<string> {
  const ids = new Set<string>();
  for (const line of readMaybeCompressed(path).split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string; text?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "chunk" || typeof event.text !== "string") continue;
    for (const match of event.text.matchAll(ID_RE)) ids.add(match[1]!);
  }
  return ids;
}

function assistantTurns(sessionPath: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of readFileSync(sessionPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: { type?: string; timestamp?: string; message?: { role?: string; responseId?: string; responseModel?: string } };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "message" || record.message?.role !== "assistant") continue;
    turns.push({
      timestamp: record.timestamp ?? "",
      responseId: record.message.responseId,
      model: record.message.responseModel,
    });
  }
  return turns;
}

/** Strip the `.jsonl` / `.jsonl.br` suffix to recover the log id (stem). */
function stemOf(file: string): string {
  return file.replace(/\.jsonl(\.br)?$/, "");
}

function main(): void {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  const [sessionPath, logsArg] = positional;

  if (!sessionPath) {
    console.error("usage: bun scripts/link-session-logs.ts <session.jsonl> [logsDir] [--all] [--json]");
    process.exit(2);
  }

  const logsDir =
    logsArg || process.env.ROUTSTRD_LOG_DIR || join(homedir(), ".routstrd", "request-response-logs");
  const responsesDir = join(logsDir, "responses");
  const requestsDir = join(logsDir, "requests");
  if (!existsSync(responsesDir)) {
    console.error(`no responses directory at ${responsesDir}`);
    process.exit(2);
  }

  const day = basename(sessionPath).slice(0, 10); // YYYY-MM-DD
  const candidates = readdirSync(responsesDir).filter(
    (file) => file.endsWith(".jsonl") || file.endsWith(".jsonl.br"),
  );
  const scanned = flags.has("--all") ? candidates : candidates.filter((file) => file.startsWith(day));

  // responseId -> response log stem(s). Usually one; retries or quoted ids can
  // make a stem appear more than once, so keep every hit.
  const byResponseId = new Map<string, string[]>();
  for (const file of scanned) {
    const stem = stemOf(file);
    for (const id of responseIds(join(responsesDir, file))) {
      const hits = byResponseId.get(id) ?? [];
      if (!hits.includes(stem)) hits.push(stem);
      byResponseId.set(id, hits);
    }
  }

  const turns = assistantTurns(sessionPath);
  const rows = turns.map((turn) => {
    const stems = turn.responseId ? (byResponseId.get(turn.responseId) ?? []) : [];
    return {
      timestamp: turn.timestamp,
      responseId: turn.responseId ?? null,
      model: turn.model ?? null,
      responseLogs: stems.map((stem) => join(responsesDir, `${stem}.jsonl`)),
      requestLogs: stems.map((stem) => {
        const plain = join(requestsDir, `${stem}.json`);
        return existsSync(plain) ? plain : join(requestsDir, `${stem}.json.br`);
      }),
      matched: stems.length > 0,
    };
  });

  if (flags.has("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const matched = rows.filter((r) => r.matched).length;
  console.log(`session : ${sessionPath}`);
  console.log(`logs    : ${logsDir}`);
  console.log(`scanned : ${scanned.length} response log(s)${flags.has("--all") ? " (all)" : ` for ${day}`}`);
  console.log(`turns   : ${rows.length} assistant message(s), ${matched} matched\n`);

  const width = Math.max(...rows.map((r) => (r.responseId ?? "—").length), 10);
  for (const row of rows) {
    const id = (row.responseId ?? "—").padEnd(width);
    const hit = row.matched ? row.responseLogs[0]!.replace(`${logsDir}/`, "") : "NO MATCH";
    console.log(`  ${row.timestamp}  ${id}  ${hit}`);
  }

  const unmatched = rows.filter((r) => !r.matched);
  if (unmatched.length > 0) {
    console.log(
      `\n${unmatched.length} unmatched turn(s). If the session spans midnight or the logs were` +
        ` rotated, re-run with --all. Pre-responseId pi versions cannot be matched this way.`,
    );
  }
}

main();
