import { renderSessionBreakdown } from "./sessions-breakdown.ts";
import { renderBox, renderRequestTable, type RequestTableEntry } from "./render.ts";
import { emptyClientNaming, type ClientNaming } from "./data.ts";
import { basename } from "node:path";
import { COLORS } from "./constants.ts";
import { cleanText, sessionTotals, visibleSessionTurns, hiddenFailedAttempt, localPreSendFailure, accountingSessionTurns, type PiSession, type SessionsResult } from "./sessions-data.ts";
export interface SessionsView { result: SessionsResult | null; selected: number; detail: boolean; filter: string; searching: boolean; loading: boolean; limit: number }
export function createSessionsView(): SessionsView { return { result: null, selected: 0, detail: false, filter: "", searching: false, loading: false, limit: 20 }; }
export function filteredSessions(v: SessionsView): PiSession[] {
  const q = v.filter.toLowerCase();
  return (v.result?.sessions ?? []).filter(s => `${s.title} ${s.cwd} ${s.id} ${s.sourceLabel || ""}`.toLowerCase().includes(q));
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

export function sessionModels(session: PiSession): string {
  const models = [...new Set(visibleSessionTurns(session).map(t => t.model.trim()).filter(m => m && m !== "Unknown"))];
  return models.join(", ") || "—";
}
export function sessionRequestEntries(session: PiSession): RequestTableEntry[] {
  return session.turns.map((t, i) => ({ t, i })).filter(({ t }) => !hiddenFailedAttempt(t)).map(({ t, i }) => ({
    id: `${session.id}:${i}`, requestId: t.responseId ?? "", timestamp: Date.parse(t.timestamp) || 0,
    modelId: t.model, baseUrl: t.node, provider: t.provider, client: t.client ?? "unknown",
    estimatedMissedTokens: t.missed,
    satsCost: t.sats, cost: 0, promptTokens: t.prompt, completionTokens: t.output,
    totalTokens: (t.prompt ?? 0) + (t.output ?? 0), cacheReadInputTokens: t.cacheRead ?? undefined,
  })).reverse();
}
export function renderSessions(v: SessionsView, width: number, height = 20, naming: ClientNaming = emptyClientNaming()): string[] {
  const lines: string[] = [];
  const add = (s: string) => lines.push(s);
  if (!v.detail) add(`Sessions ${v.loading ? "· Loading…" : ""}  / filter: ${cleanText(v.filter)}${v.searching ? "_" : ""}`);
  if (v.result?.error) add(`Error: ${cleanText(v.result.error)}`);
  if (!v.result) { add(v.loading ? "Reading recent Pi sessions…" : "Press R to load sessions"); return lines; }
  const sessions = filteredSessions(v);
  v.selected = Math.max(0, Math.min(v.selected, sessions.length - 1));
  const session = sessions[v.selected];
  if (!session) { add("No sessions match (or no Pi transcripts found)."); return lines; }
  if (!v.detail) {
    add("↑↓ select · Enter details · / filter · R refresh · M load 20 more (up to 200)");
    add("* Estimated misses >1,024 tokens; — means no eligible comparisons / unknown spend.");
    const headers = width < 70
      ? ["Active", "Project", "First prompt", "Models", "sats", "M*", "Tokens*"]
      : ["Last active", "Project", "First user message", "Models", "sats", "Misses*", "Miss tokens*"];
    // One row per session at all sizes. Reserve numeric cells before flexing title.
    const widths = width < 70 ? [3, 3, 2, 3, 6, 2, 5] : width < 100 ? [8, 9, 8, 9, 9, 7, 10] : [11, 14, 16, 17, 10, 8, 12];
    const spare = Math.max(0, width - 4 - 2 - 6 - widths.reduce((sum, n) => sum + n, 0));
    widths[3]! += Math.floor(spare / 2);
    widths[2]! += spare - Math.floor(spare / 2);
    const numeric = (value: string, n: number) => value.length <= n ? value.padStart(n)
      : (value.endsWith("+?") ? fit(value.slice(0, -2), n - 2).trimEnd() + "+?" : fit(value, n));
    const cells = (values: string[]) => values.map((v, i) => i >= 4 ? numeric(v, widths[i]!) : fit(v, widths[i]!)).join(" ");
    const table = [`${COLORS.bold}  ${cells(headers)}${COLORS.reset}`, `${COLORS.dim}${"─".repeat(Math.max(0, width - 4))}${COLORS.reset}`];
    const capacity = Math.max(1, height - lines.length - 4 - (v.result.more ? 1 : 0));
    const start = Math.max(0, v.selected - capacity + 1);
    const shown = sessions.slice(start, start + capacity);
    shown.forEach((s, offset) => {
      const turns = accountingSessionTurns(s);
      const t = sessionTotals(turns);
      const values = [age(s.active), s.sourceLabel || basename(s.cwd) || "Unknown", s.title, sessionModels(s),
        t.sats === null ? (turns.length ? "—+?" : "—") : money(t.sats) + (t.priced < turns.length ? "+?" : ""),
        t.eligible ? count(t.misses) : "—", t.eligible ? count(t.missed) : "—"];
      const row = values.map((value, i) => {
        const text = i >= 4 ? numeric(value, widths[i]!) : fit(value, widths[i]!);
        const color = i >= 5 && t.misses > 0 ? COLORS.red : i === 4 ? COLORS.cyan : i === 0 ? COLORS.dim : "";
        return color + text + (color ? COLORS.reset : "");
      }).join(" ");
      table.push(`${start + offset === v.selected ? ">" : " "} ${row}`);
    });
    lines.push(...renderBox(table, width, `Sessions (${sessions.length} shown)`).split("\n"));
    if (v.result.more) add("More sessions available: M");
  } else {
    const turns = accountingSessionTurns(session);
    const totals = sessionTotals(turns);
    add(`${COLORS.bold}Title:${COLORS.reset} ${session.title}`);
    // Paths and identifiers are wrapped, never permanently lost to truncation.
    for (const text of [`Session: ${session.id}`, `Project: ${session.cwd}`]) {
      for (let i = 0; i < text.length; i += Math.max(1, width)) add(text.slice(i, i + Math.max(1, width)));
    }
    if (session.sourceLabel) add(`Source: ${session.sourceLabel}`);
    add(`Recorded: ${money(totals.sats)}${totals.priced < turns.length ? "+?" : ""} sats · priced ${totals.priced}/${turns.length} · matched ${totals.matched}/${turns.length}`);
    add(`Estimated misses*: ${totals.eligible ? totals.misses : "—"} · missed tokens*: ${totals.eligible ? count(totals.missed) : "—"} · eligible comparisons ${totals.eligible}`);
    for (const warning of session.warnings) add(`Warning: ${warning}`);
    const excluded = session.turns.filter(localPreSendFailure).length;
    const hiddenUnknown = session.turns.filter(t => hiddenFailedAttempt(t) && !localPreSendFailure(t)).length;
    if (excluded) add(`${excluded} local pre-send failures excluded`);
    if (hiddenUnknown) add(`${hiddenUnknown} failed attempts; spend unknown`);
    const issues = turns.filter(t => t.match !== "matched");
    if (issues.length) add(`Incomplete attribution: ${issues.length} missing / ambiguous / repeated response IDs; spend not assumed zero.`);
    add("");
    lines.push(...renderSessionBreakdown(visibleSessionTurns(session), width).split("\n"));
    add("");
    add("Requests: same table as Recent, newest first; unknown accounting is — sats.");
    lines.push(...renderRequestTable(sessionRequestEntries(session), width, naming, `Session Requests (${visibleSessionTurns(session).length} shown)`).split("\n"));
    const misses = session.turns.map((t, i) => ({ t, i })).filter(({ t }) => !hiddenFailedAttempt(t) && t.missed > 0);
    if (misses.length) {
      add(`${COLORS.red}Estimated cache miss events (transcript positions):${COLORS.reset}`);
      for (const { t, i } of misses) add(`#${i + 1} ${t.timestamp} · ${t.missed} missed tokens · ${t.node} × ${t.provider}`);
    }
    const unresolved = session.turns.map((t, i) => ({ t, i })).filter(({ t }) => !hiddenFailedAttempt(t) && (t.match !== "matched" || t.sats === null || t.prompt === null || t.output === null));
    if (unresolved.length) {
      add("Accounting / usage gaps (transcript positions):");
      for (const { t, i } of unresolved) add(`#${i + 1} ${t.timestamp} · ${t.match} · ${t.responseId ?? "no response ID"}${t.sats === null ? " · price unknown" : ""}${t.prompt === null || t.output === null ? " · tokens unknown" : ""}`);
    }
  }
  return lines;
}
