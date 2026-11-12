import { basename } from "node:path";
import { COLORS } from "./constants.ts";
import { cleanText, sessionTotals, type PiSession, type SessionsResult } from "./sessions-data.ts";
export interface SessionsView { result: SessionsResult | null; selected: number; detail: boolean; filter: string; searching: boolean; loading: boolean; limit: number }
export function createSessionsView(): SessionsView { return { result: null, selected: 0, detail: false, filter: "", searching: false, loading: false, limit: 20 }; }
export function filteredSessions(v: SessionsView): PiSession[] {
  const q = v.filter.toLowerCase();
  return (v.result?.sessions ?? []).filter(s => `${s.title} ${s.cwd} ${s.id}`.toLowerCase().includes(q));
}
/** Returns true when a key belongs to this view; tab switching and quitting remain global. */
export function sessionsKey(v: SessionsView, key: string): boolean {
  if (v.searching) {
    if (key === "\x1b" || key === "\r" || key === "\n") v.searching = false;
    else if (key === "\x7f" || key === "\x08") v.filter = v.filter.slice(0, -1);
    else if (key.length === 1 && key >= " ") v.filter += key;
    v.selected = 0; return true;
  }
  if (key === "\x1b" || key === "\x7f") { v.detail = false; return true; }
  if (!v.detail) {
    if (key === "/") { v.searching = true; return true; }
    if (key === "\r" || key === "\n") { v.detail = filteredSessions(v).length > 0; return true; }
    if (key === "j" || key === "\x1b[B" || key === "\x1bOB") { v.selected = Math.min(filteredSessions(v).length - 1, v.selected + 1); return true; }
    if (key === "k" || key === "\x1b[A" || key === "\x1bOA") { v.selected = Math.max(0, v.selected - 1); return true; }
  }
  return false;
}
const money = (n: number | null) => n === null ? "—" : n.toFixed(2);
const count = (n: number) => n.toLocaleString("en-US");
const fit = (s: string, n: number) => s.length <= n ? s.padEnd(n) : s.slice(0, Math.max(0, n - 1)) + "…";
const age = (t: number) => !t ? "unknown" : Math.max(0, Math.floor((Date.now() - t) / 60000)) < 60 ? `${Math.max(0, Math.floor((Date.now() - t) / 60000))}m ago` : `${Math.floor((Date.now() - t) / 3600000)}h ago`;

export function renderSessions(v: SessionsView, width: number, height = 20): string[] {
  const lines: string[] = [];
  const add = (s: string) => lines.push(s);
  add(`Sessions ${v.loading ? "· Loading…" : ""}  / filter: ${cleanText(v.filter)}${v.searching ? "_" : ""}`);
  if (v.result?.error) add(`Error: ${cleanText(v.result.error)}`);
  if (!v.result) { add(v.loading ? "Reading recent Pi sessions…" : "Press R to load sessions"); return lines; }
  const sessions = filteredSessions(v);
  v.selected = Math.max(0, Math.min(v.selected, sessions.length - 1));
  const session = sessions[v.selected];
  if (!session) { add("No sessions match (or no Pi transcripts found)."); return lines; }
  if (!v.detail) {
    add("↑↓ select · Enter details · / filter · R refresh · M load 20 more (up to 200)");
    add("* Estimated misses >1,024 tokens; — means no eligible comparisons / unknown spend.");
    if (width >= 100) {
      const titleWidth = Math.max(12, width - 76);
      add(`  ${fit("Last active", 11)} ${fit("Project", 17)} ${fit("First user message", titleWidth)} ${fit("sats", 10)} ${fit("Misses*", 8)} Miss tokens*`);
      const start = Math.max(0, v.selected - Math.max(0, height - 8));
      for (const [i, s] of sessions.entries()) {
        if (i < start) continue;
        const t = sessionTotals(s.turns);
        add(`${i === v.selected ? ">" : " "} ${fit(age(s.active), 11)} ${fit(basename(s.cwd) || "Unknown", 17)} ${fit(s.title, titleWidth)} ${fit(money(t.sats) + (t.priced < s.turns.length ? "+?" : ""), 10)} ${fit(t.eligible ? count(t.misses) : "—", 8)} ${t.eligible ? count(t.missed) : "—"}`);
      }
    } else {
      const start = Math.max(0, v.selected - Math.max(0, Math.floor((height - 6) / 2)));
      for (const [i, s] of sessions.entries()) {
        if (i < start) continue;
        const t = sessionTotals(s.turns);
        add(`${i === v.selected ? ">" : " "} ${fit(basename(s.cwd), 15)} ${s.title}`);
        add(`  ${age(s.active)} · ${money(t.sats)} sats${t.priced < s.turns.length ? " + unknown" : ""} · misses*: ${t.eligible ? `${t.misses} / ${count(t.missed)} tokens` : "—"}`);
      }
    }
    if (v.result.more) add("More sessions available: M");
  } else {
    const totals = sessionTotals(session.turns);
    add("Esc back · ↑↓ scroll · R refresh");
    add(session.title);
    // Paths and identifiers are wrapped, never permanently lost to truncation.
    for (const text of [`Session: ${session.id}`, `Project: ${session.cwd}`, `Transcript: ${session.path}`]) {
      for (let i = 0; i < text.length; i += Math.max(1, width)) add(text.slice(i, i + Math.max(1, width)));
    }
    add(`Recorded: ${money(totals.sats)} sats · priced ${totals.priced}/${session.turns.length} · matched ${totals.matched}/${session.turns.length}`);
    add(`Estimated misses*: ${totals.eligible ? totals.misses : "—"} · missed tokens*: ${totals.eligible ? count(totals.missed) : "—"} · eligible comparisons ${totals.eligible}`);
    add(`Pi tokens: ${count(session.turns.reduce((s, t) => s + (t.prompt ?? 0), 0))} prompt / ${count(session.turns.reduce((s, t) => s + (t.output ?? 0), 0))} output (known usage only)`);
    add("* Pi heuristic; assumes unchanged prefix, does not compare prompt contents.");
    for (const warning of session.warnings) add(`Warning: ${warning}`);
    const issues = session.turns.filter(t => t.match !== "matched");
    if (issues.length) add(`Incomplete attribution: ${issues.length} missing / ambiguous / repeated response IDs; spend not assumed zero.`);
    add(""); add("NODE × PROVIDER | turns | sats | misses* | missed tokens*");
    const buckets = new Map<string, typeof session.turns>();
    for (const turn of session.turns) {
      const k = `${turn.node} × ${turn.provider}`;
      const group = buckets.get(k) ?? []; group.push(turn); buckets.set(k, group);
    }
    for (const [key, turns] of buckets) {
      const t = sessionTotals(turns);
      for (let i = 0; i < key.length; i += Math.max(1, width)) add(key.slice(i, i + Math.max(1, width)));
      add(`  ${turns.length} turns | ${money(t.sats)} sats${t.priced < turns.length ? " + unknown" : ""} | ${t.eligible ? t.misses : "—"} misses | ${t.eligible ? count(t.missed) : "—"} tokens`);
    }
    add(""); add("PER REQUEST (transcript order): time · cache reads · missed tokens* · sats");
    session.turns.forEach((t, i) => {
      const marker = t.missed ? "!" : " ";
      const label = `${marker}${i + 1} ${t.timestamp} · read ${t.cacheRead ?? "—"} · miss ${t.eligible ? t.missed : "—"} · ${money(t.sats)} sats [${t.match}]`;
      add(t.missed ? `${COLORS.yellow}${label}${COLORS.reset}` : label);
      add(`  ${t.model} · ${t.provider}`);
      for (let j = 0; j < t.node.length; j += Math.max(1, width - 2)) add(`  ${t.node.slice(j, j + Math.max(1, width - 2))}`);
    });
  }
  return lines;
}
