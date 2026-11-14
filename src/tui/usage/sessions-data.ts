import { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { readdir, stat, realpath, readFile, opendir } from "node:fs/promises";
import { basename, join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

import type { SessionSourceConfig } from "../../utils/config.ts";

export interface SessionTurn {
  errorMessage?: string; stopReason?: string; responseId?: string; timestamp: string; model: string;
  prompt: number | null; output: number | null; cacheRead: number | null;
  missed: number; eligible: boolean; node: string; provider: string;
  client?: string; sats: number | null; match: "missing" | "matched" | "ambiguous" | "duplicate";
}
export interface PiSession {
  sourceLabel?: string;
  id: string; path: string; cwd: string; title: string; active: number;
  turns: SessionTurn[]; warnings: string[];
}
export interface SessionsResult { sessions: PiSession[]; more: boolean; error?: string }
export const cleanText = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** Bounded line reader: never retain an entire transcript or oversized payload line. */
export async function* transcriptLines(path: string, warnings: string[]) {
  let pending = "", skipping = false, bytes = 0;
  const maxLine = 2 * 1024 * 1024;
  for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 })) {
    bytes += Buffer.byteLength(chunk as string);
    if (bytes > 32 * 1024 * 1024) { warnings.push("Transcript exceeds 32 MiB; results incomplete"); return; }
    const parts = (chunk as string).split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (!skipping) pending += parts[i];
      if (pending.length > maxLine) { pending = ""; skipping = true; warnings.push("Oversized transcript line skipped; results incomplete"); }
      if (i < parts.length - 1) {
        // Empty string signals a gap, resetting cache predecessor conservatively.
        yield skipping ? "!invalid" : pending;
        pending = ""; skipping = false;
      }
    }
  }
  if (pending || skipping) yield skipping ? "!invalid" : pending;
}

export async function parseSession(path: string, active: number, source?: SessionSourceConfig): Promise<PiSession> {
  const session: PiSession = { id: basename(path, ".jsonl"), path, cwd: "", title: "", active, turns: [], warnings: [] };
  session.sourceLabel = source ? cleanText(source.label || (source.kind === "bunkhouse" ? `Bunkhouse · ${basename(resolve(source.path, ".."))}` : "")) || undefined : undefined;
  let prev: { prompt: number; cached: boolean } | undefined;
  let firstUser = false;
  for await (const line of transcriptLines(path, session.warnings)) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); if (!e || typeof e !== "object") throw Error(); }
    catch { if (!session.warnings.includes("Malformed transcript entries skipped")) session.warnings.push("Malformed transcript entries skipped"); prev = undefined; continue; }
    if (e.type === "session") { session.id = typeof e.id === "string" ? cleanText(e.id) : session.id; session.cwd = typeof e.cwd === "string" ? cleanText(e.cwd) : ""; }
    const timestamp = typeof e.timestamp === "string" ? e.timestamp : "";
    const time = Date.parse(timestamp);
    if (Number.isFinite(time)) session.active = Math.max(session.active, time);
    if (e.type === "compaction" || e.type === "branch_summary") { prev = undefined; continue; }
    const m = e.message;
    if (e.type === "message" && m?.role === "user" && !firstUser) {
      firstUser = true;
      const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join(" ") : "";
      // Only explicitly marked Bunkhouse sources interpret framing tags.
      const body = source?.kind === "bunkhouse" ? bunkhouseMessage(content) : content;
      session.title = cleanText(body).slice(0, 500);
    }
    const warm = e.type === "usage" && e.kind === "cache_warm";
    if (!warm && !(e.type === "message" && m?.role === "assistant")) continue;
    const u = (warm ? e.usage : m.usage) ?? {};
    const input = number(u.input), read = number(u.cacheRead), write = number(u.cacheWrite);
    const prompt = input !== null && read !== null && write !== null ? input + read + write : null;
    if (warm) { if (prompt !== null && prompt > 0) prev = { prompt, cached: true }; continue; }
    const eligible = prompt !== null && prompt > 0 && !!prev && (read! + write! > 0 || prev.cached);
    const missed = eligible ? Math.min(prev!.prompt, prompt!) - read! : 0;
    if (session.turns.length >= 5000) { session.warnings.push("Session exceeds 5,000 assistant entries; results incomplete"); break; }
    session.turns.push({ errorMessage: typeof m.errorMessage === "string" ? m.errorMessage.slice(0, 2000) : undefined, stopReason: typeof m.stopReason === "string" ? m.stopReason : undefined, responseId: typeof m.responseId === "string" ? m.responseId : undefined, timestamp: cleanText(timestamp), model: cleanText(typeof m.model === "string" ? m.model : "Unknown"), prompt, output: number(u.output), cacheRead: read, missed: missed > 1024 ? missed : 0, eligible, node: "Unknown", provider: "Unknown", sats: null, match: "missing" });
    if (prompt === null) prev = undefined;
    else if (prompt > 0) prev = { prompt, cached: (prev?.cached ?? false) || read! + write! > 0 };
  }
  if (!session.title) session.title = firstUser ? "[First message has no text]" : "[No user message]";
  return session;
}

/** Read-only, schema-adaptive accounting. Duplicate keys are not silently billed twice. */
export function attributeUsage(session: PiSession, db: Database): void {
  const columns = new Set((db.query("PRAGMA table_info(usage_tracking)").all() as { name: string }[]).map(c => c.name));
  if (!columns.has("request_id")) throw Error("Database has no usage_tracking request_id column");
  const key = columns.has("upstream_response_id") ? "coalesce(nullif(upstream_response_id,''),request_id)" : "request_id";
  const select = (name: string) => columns.has(name) ? name : `NULL AS ${name}`;
  const ids = [...new Set(session.turns.flatMap(t => t.responseId ? [t.responseId] : []))];
  const matches = new Map<string, any[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const rows = db.query(`SELECT ${key} AS response_key, ${["base_url", "provider", "client", "sats_cost", "total_msats"].map(select).join(",")} FROM usage_tracking WHERE ${key} IN (${batch.map(() => "?").join(",")})`).all(...batch) as any[];
    for (const row of rows) { const values = matches.get(row.response_key) ?? []; values.push(row); matches.set(row.response_key, values); }
  }
  const seen = new Set<string>();
  for (const turn of session.turns) {
    if (!turn.responseId) continue;
    const rows = matches.get(turn.responseId) ?? [];
    if (rows.length > 1) { turn.match = "ambiguous"; continue; }
    if (!rows.length) continue;
    const row = rows[0];
    turn.client = typeof row.client === "string" ? cleanText(row.client) : undefined;
    turn.node = typeof row.base_url === "string" && row.base_url ? cleanText(row.base_url) : "Unknown";
    turn.provider = typeof row.provider === "string" && row.provider ? cleanText(row.provider) : "Unknown";
    if (seen.has(turn.responseId)) { turn.match = "duplicate"; continue; }
    seen.add(turn.responseId); turn.match = "matched";
    turn.sats = number(row.sats_cost) ?? (number(row.total_msats) !== null ? row.total_msats / 1000 : null);
  }
}

/** Hidden rows are NOT automatically excluded from accounting coverage. */
export function hiddenFailedAttempt(turn: SessionTurn): boolean {
  return (turn.stopReason === "error" || turn.stopReason === "aborted") &&
    turn.prompt === 0 && turn.output === 0 && turn.match === "missing" && turn.sats === null;
}
/** Narrow module-loader signature for Pi's local provider; never arbitrary message keywords. */
export function localPreSendFailure(turn: SessionTurn): boolean {
  if (!hiddenFailedAttempt(turn) || turn.stopReason !== "error" || turn.responseId) return false;
  const text = turn.errorMessage ?? "";
  return /^(?:Error: )?(?:Cannot find module|Cannot import module) ['"]\/[^\n'"]*\/(?:@earendil-works|@mariozechner)\/pi-ai\/(?:dist|src)\/providers\/openai-responses\.(?:js|ts)['"](?:$| imported from ['"]\/[^\n'"]+['"]$)/.test(text);
}
export function accountingSessionTurns(session: PiSession): SessionTurn[] {
  return session.turns.filter(t => !localPreSendFailure(t));
}
export function visibleSessionTurns(session: PiSession): SessionTurn[] {
  return session.turns.filter(t => !hiddenFailedAttempt(t));
}

export function sessionTotals(turns: SessionTurn[]) {
  const priced = turns.filter(t => t.sats !== null);
  return { sats: priced.length ? priced.reduce((s, t) => s + t.sats!, 0) : null, priced: priced.length, matched: turns.filter(t => t.match === "matched").length, misses: turns.filter(t => t.missed > 0).length, missed: turns.reduce((s, t) => s + t.missed, 0), eligible: turns.filter(t => t.eligible).length };
}

/** Lives in a worker; metadata discovery and transcript cache never run in the paint loop. */
export class SessionsLoader {
  private cache = new Map<string, { signature: string; session: PiSession }>();
  constructor(private root = join(homedir(), ".pi/agent/sessions"), private dbPath = join(process.env.ROUTSTRD_DIR || join(homedir(), ".routstrd"), "routstr.db"), private sources?: SessionSourceConfig[]) {}
  async load(limit = 20): Promise<SessionsResult> {
    try {
      const notices: string[] = [];
      const sources = this.sources ?? await configuredSessionSources(notices);
      const files: { path: string; mtime: number; signature: string; source?: SessionSourceConfig }[] = [];
      const seen = new Set<string>();
      const seenDirectories = new Set<string>();
      let inspected = 0;
      const directories: { path: string; source?: SessionSourceConfig }[] = sources.map(source => ({ path: source.path, source }));
      try {
        for (const dir of await readdir(this.root, { withFileTypes: true })) {
          if (dir.isDirectory()) directories.push({ path: join(this.root, dir.name) });
        }
      } catch (e: any) { if (e.code !== "ENOENT") notices.push("Default Pi session directory unavailable"); }
      for (const directory of directories.slice(0, 1000)) {
        try {
          const canonicalDirectory = await realpath(directory.path);
          if (seenDirectories.has(canonicalDirectory)) continue;
          seenDirectories.add(canonicalDirectory);
          for await (const entry of await opendir(canonicalDirectory)) {
            if (++inspected > 50000) break;
            const file = entry.name;
            if (!file.endsWith(".jsonl")) continue;
            try {
              const path = await realpath(join(directory.path, file));
              if (seen.has(path)) continue;
              const s = await stat(path);
              if (!s.isFile()) continue;
              seen.add(path);
              files.push({ path, mtime: s.mtimeMs, signature: `${s.mtimeMs}:${s.size}:${JSON.stringify(directory.source)}`, source: directory.source });
            } catch { /* removed during discovery */ }
          }
        } catch { notices.push(`Session source unavailable: ${cleanText(directory.source?.label || directory.path)}`); }
        if (inspected > 50000) { notices.push("Session discovery limited to 50,000 directory entries; results incomplete"); break; }
      }
      if (directories.length > 1000) notices.push("Session discovery limited to 1,000 directories");
      files.sort((a, b) => b.mtime - a.mtime);
      const sessions: PiSession[] = [];
      let totalTurns = 0;
      const identities = new Set<string>();
      for (const f of files.slice(0, Math.min(limit, 200))) {
        if (totalTurns >= 20000) break;
        try {
          const cached = this.cache.get(f.path);
          const parsed = cached?.signature === f.signature ? cached.session : await parseSession(f.path, 0, f.source);
          this.cache.set(f.path, { signature: f.signature, session: parsed });
          // Copies of the same persisted session must not duplicate spend.
          if (identities.has(parsed.id)) {
            notices.push("Duplicate session identity omitted; newest copy shown");
            sessions.find(s => s.id === parsed.id)?.warnings.push("Duplicate session identity; cache estimates unavailable in Recent");
            continue;
          }
          identities.add(parsed.id);
          sessions.push(structuredClone(parsed));
          totalTurns += parsed.turns.length;
        } catch { /* inaccessible transcript; continue listing other sessions */ }
      }
      // Bound retained parsed metadata even when browsing progressively older sessions.
      const retained = new Set(sessions.map(s => s.path));
      for (const path of this.cache.keys()) if (!retained.has(path)) this.cache.delete(path);
      let error: string | undefined = totalTurns >= 20000 ? "Page reached 20,000-turn safety limit; older sessions omitted" : undefined;
      let db: Database | undefined;
      try { db = new Database(this.dbPath, { readonly: true }); for (const s of sessions) attributeUsage(s, db); }
      catch (e) { error = `Accounting unavailable: ${e instanceof Error ? e.message : String(e)}`; }
      finally { db?.close(); }
      sessions.sort((a, b) => b.active - a.active);
      if (notices.length) error = [error, ...new Set(notices)].filter(Boolean).join("; ");
      return { sessions, more: files.length > limit && limit < 200, error };
    } catch (e) { return { sessions: [], more: false, error: e instanceof Error ? e.message : String(e) }; }
  }
}

/** Bunkhouse appends the current message after optional conversation context. */
export function bunkhouseMessage(content: string): string {
  const contextEnd = content.indexOf("</context>");
  const afterContext = contextEnd >= 0 ? content.slice(contextEnd + 10) : content;
  const conversationEnd = afterContext.lastIndexOf("</conversation-context>");
  const current = conversationEnd >= 0 ? afterContext.slice(conversationEnd + "</conversation-context>".length) : afterContext;
  return /<message(?:\s[^>]*)?>([\s\S]*?)<\/message>/.exec(current)?.[1] ?? "[Bunkhouse message unavailable]";
}

/** Read only this nonsecret config section; never expose the config payload in errors. */
export async function configuredSessionSources(notices: string[] = []): Promise<SessionSourceConfig[]> {
  const dir = process.env.ROUTSTRD_DIR || join(homedir(), ".routstrd");
  try {
    const path = join(dir, "config.json");
    if ((await stat(path)).size > 1024 * 1024) throw Error();
    const config = JSON.parse(await readFile(path, "utf8"));
    if (config.sessionSources === undefined) return [];
    if (!Array.isArray(config.sessionSources)) throw Error();
    const sources: SessionSourceConfig[] = [];
    for (const source of config.sessionSources.slice(0, 100)) {
      if (!source || typeof source.path !== "string" || !["pi", "bunkhouse"].includes(source.kind) || (source.label !== undefined && typeof source.label !== "string")) { notices.push("Invalid session source ignored"); continue; }
      const path = source.path.startsWith("~/") ? join(homedir(), source.path.slice(2)) : source.path;
      if (!isAbsolute(path)) { notices.push("Session source requires an absolute path"); continue; }
      sources.push({ path, kind: source.kind, label: source.label });
    }
    if (config.sessionSources.length > 100) notices.push("Session sources limited to 100");
    return sources;
  } catch (e: any) {
    if (e.code !== "ENOENT") notices.push("Session source configuration unavailable or invalid");
    return [];
  }
}
