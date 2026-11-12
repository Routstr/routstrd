import { COLORS } from "./constants.ts";
import { renderSessionBreakdown } from "./sessions-breakdown.ts";
import { renderRecent, renderRequestTable } from "./render.ts";
import { emptyClientNaming } from "./data.ts";
import type { UsageStats } from "./types.ts";
import { stripAnsi } from "./terminal.ts";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributeUsage, parseSession, sessionTotals, SessionsLoader } from "./sessions-data.ts";
import { createSessionsView, sessionsKey, renderSessions, sessionRequestEntries } from "./sessions-view.ts";
import { getVisibleTabs, tabSupportsWindow } from "./constants.ts";
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function fixture(entries: unknown[]) {
 const dir = mkdtempSync(join(tmpdir(), "pi-sessions-")); dirs.push(dir);
 const path = join(dir, "session.jsonl");
 writeFileSync(path, entries.map(e => typeof e === "string" ? e : JSON.stringify(e)).join("\n")); return path;
}
const assistant = (input: number, cacheRead = 0, cacheWrite = 0, responseId = "r") => ({ type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", responseId, model: "model", usage: { input, cacheRead, cacheWrite, output: 5 } } });
test("Pi threshold, sticky reporting, zero usage, first turn and resets", async () => {
 const s = await parseSession(fixture([
 assistant(0, 70000), assistant(1024, 68976), assistant(1025, 68975), assistant(0), assistant(71000),
 { type: "compaction" }, assistant(71000), assistant(71000),
 { type: "usage", kind: "cache_warm", usage: { input: 71000, cacheRead: 0, cacheWrite: 0 } }, assistant(71000),
 { type: "branch_summary" }, assistant(71000), assistant(0, 71000),
 ]), 0);
 expect(s.turns.map(t => t.missed)).toEqual([0, 0, 1025, 0, 70000, 0, 0, 71000, 0, 0]);
 expect(sessionTotals(s.turns).misses).toBe(3);
});
test("first user text only, malformed entries, positive error usage", async () => {
 const err = assistant(8000); Object.assign(err.message, { stopReason: "error", provider: "different" });
 const s = await parseSession(fixture([{ type: "session", id: "s", cwd: "/p/project" }, { type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: " Hello\n world\u001b[2J " }] } }, assistant(0, 7000), err, "broken", assistant(8000)]), 0);
 expect(s.title).toBe("Hello world [2J"); expect(s.cwd).toBe("/p/project");
 expect(s.turns.map(t => t.missed)).toEqual([0, 7000, 0]); expect(s.warnings.length).toBe(1);
});
test("attribution crosses bucket boundary; duplicate keys and prices remain explicit", async () => {
 const s = await parseSession(fixture([assistant(0, 7000, 0, "a"), assistant(8000, 0, 0, "b"), assistant(8000, 0, 0, "b"), assistant(8000, 0, 0, "amb"), assistant(8000, 0, 0, "missing")]), 0);
 const db = new Database(":memory:");
 db.exec("CREATE TABLE usage_tracking (request_id TEXT, upstream_response_id TEXT, base_url TEXT, provider TEXT, sats_cost REAL, total_msats REAL)");
 const insert = db.query("INSERT INTO usage_tracking VALUES (?, ?, ?, ?, ?, ?)");
 insert.run("life-a", "a", "node-a", "Together", 1, null);
 insert.run("b", "", "node-b", "Cloudflare", null, 2000);
 insert.run("amb", null, "node", "p", 3, null); insert.run("amb", null, "node", "p", 3, null);
 insert.run("missing", null, null, null, null, null);
 attributeUsage(s, db); db.close();
 expect(s.turns.map(t => t.match)).toEqual(["matched", "matched", "duplicate", "ambiguous", "matched"]);
 expect(s.turns[1]!.missed).toBe(7000); expect(s.turns[1]!.provider).toBe("Cloudflare");
 expect(s.turns[3]!.node).toBe("Unknown"); expect(s.turns[4]!.sats).toBeNull();
 expect(sessionTotals(s.turns).sats).toBe(3);
});
test("legacy schema uses request ID and leaves absent cost unknown", async () => {
 const s = await parseSession(fixture([assistant(100)]), 0);
 const db = new Database(":memory:"); db.exec("CREATE TABLE usage_tracking(request_id TEXT); INSERT INTO usage_tracking VALUES ('r')");
 attributeUsage(s, db); db.close(); expect(s.turns[0]!.match).toBe("matched"); expect(sessionTotals(s.turns).sats).toBeNull();
});
test("navigation, filter, tab order and sats-only detail", async () => {
 const s = await parseSession(fixture([assistant(0, 7000), assistant(8000)]), 0);
 const v = createSessionsView(); v.result = { sessions: [s], more: false };
 expect(sessionsKey(v, "\r")).toBe(true); expect(v.detail).toBe(true);
 const detail = renderSessions(v, 80).join("\n"); expect(detail).toContain("Unknown × Unknown"); expect(detail).toContain("7000"); expect(detail).not.toContain("USD");
 sessionsKey(v, "\x1b"); expect(v.detail).toBe(false);
 sessionsKey(v, "/"); sessionsKey(v, "z"); sessionsKey(v, "\r"); expect(renderSessions(v, 40).join("\n")).toContain("No sessions match");
 const tabs = getVisibleTabs(true); expect(tabs[tabs.findIndex(t => t.id === "recent") - 1]!.id).toBe("sessions"); expect(tabSupportsWindow("sessions")).toBe(false);
});
test("missing database never created and missing root is recoverable", async () => {
 const path = fixture([]); const loader = new SessionsLoader(path + "-missing", path + "-db");
 expect((await loader.load()).error).toBeDefined();
});

test("worker loads bounded fixture page and never creates absent accounting DB", async () => {
 const home = mkdtempSync(join(tmpdir(), "pi-worker-")); dirs.push(home);
 const root = join(home, ".pi/agent/sessions/project"); mkdirSync(root, { recursive: true });
 writeFileSync(join(root, "s.jsonl"), [
  { type: "session", id: "fixture", cwd: "/project" },
  { type: "message", message: { role: "user", content: "Actual first prompt" } }, assistant(100)
 ].map(e => JSON.stringify(e)).join("\n"));
 const script = `const w = new Worker(new URL("./sessions-worker.ts", import.meta.url).href); w.onmessage = e => { console.log(JSON.stringify(e.data)); w.terminate(); }; w.postMessage(20);`;
 const runner = join(import.meta.dir, ".sessions-worker-smoke.ts");
 writeFileSync(runner, script);
 try {
  const process = Bun.spawn(["bun", runner], { env: { ...Bun.env, HOME: home, ROUTSTRD_DIR: join(home, ".routstrd") }, stdout: "pipe", stderr: "pipe" });
  const output = await new Response(process.stdout).text(); expect(await process.exited).toBe(0);
  const result = JSON.parse(output); expect(result.sessions[0].title).toBe("Actual first prompt"); expect(result.error).toContain("Accounting unavailable");
  expect(existsSync(join(home, ".routstrd/routstr.db"))).toBe(false);
 } finally { rmSync(runner, { force: true }); }
});

test("full app dispatch: details search keys, Escape, tabs, refresh, quit", async () => {
 const child = Bun.spawn(["bun", join(import.meta.dir, "sessions-dispatch-smoke.ts")], { stdout: "pipe", stderr: "pipe" });
 const err = await new Response(child.stderr).text();
 expect(await child.exited).toBe(0); expect(err).toContain("full dispatch OK");
});

test("session requests share Recent table layout, newest first, without losing unknown entries", async () => {
 const s = await parseSession(fixture([assistant(0, 7000, 0, "first"), assistant(8000, 0, 0, "last")]), 0);
 s.turns[0]!.sats = 1.25; s.turns[0]!.match = "matched"; s.turns[0]!.client = "pi-agent";
 s.turns[1]!.prompt = null; s.turns[1]!.output = null;
 const entries = sessionRequestEntries(s);
 expect(entries.map(e => e.requestId)).toEqual(["last", "first"]);
 const view = createSessionsView(); view.result = { sessions: [s], more: false }; view.detail = true;
 for (const width of [40, 80, 160]) {
  const shared = renderRequestTable(entries, width, emptyClientNaming(), "Session Requests (2 shown)");
  const detail = renderSessions(view, width).join("\n");
  expect(detail).toContain(shared);
  const recent = renderRecent({ entries } as unknown as UsageStats, width, emptyClientNaming());
  // Only box title differs: all request headers/rows/borders are identical.
  expect(recent.split("\n").slice(1)).toEqual(shared.split("\n").slice(1));
  if (width >= 80) {
   expect(stripAnsi(shared)).toContain("— sats");
   expect(stripAnsi(shared)).toContain("1.25 sats");
  }
  // Recent itself clips lower-priority columns at very narrow widths.
  for (const line of stripAnsi(shared).split("\n")) expect(line.length).toBeLessThanOrEqual(width);
  expect(detail).toContain("missing · last · price unknown · tokens unknown");
 }
});

test("node/provider breakdown is a bounded aligned table with partial accounting", async () => {
 const s = await parseSession(fixture([assistant(0, 7000), assistant(8000), assistant(9000)]), 0);
 for (const t of s.turns.slice(0, 2)) { t.node = "https://ai.redsh1ft.com/"; t.provider = "openrouter:Cloudflare"; }
 s.turns[0]!.sats = 12.5;
 for (const width of [40, 80, 160]) {
  const raw = renderSessionBreakdown(s.turns, width);
  const lines = stripAnsi(raw).split("\n");
  expect(lines[0]).toContain("NODE × PROVIDER");
  expect(lines[1]).toContain("Node"); if (width >= 80) expect(lines[1]).toContain("Provider");
  expect(lines[1]).toContain("sats");
  expect(lines.filter(l => l.includes("12.50+?"))).toHaveLength(1);
  expect(lines).toHaveLength(7); // border, header, separator, two combos, partial legend, border
  expect(lines.join("\n")).toContain("+? = additional unknown spend");
  for (const line of lines) expect(line.length).toBe(width);
  const satsRight = lines[1]!.indexOf("sats") + 4;
  const row = lines.find(l => l.includes("12.50+?"))!;
  expect(row.indexOf("12.50+?") + 7).toBe(satsRight);
  if (width >= 80) { expect(lines[1]).toContain("Missed tokens*"); expect(raw).toContain("openrouter:Cloudflare"); }
 }
 expect(s.turns[0]!.node).toBe("https://ai.redsh1ft.com/");
 expect(s.turns[0]!.provider).toBe("openrouter:Cloudflare");
});

test("detail header is Title/Session/Project only while list filter stays available", async () => {
 const s = await parseSession(fixture([
  { type: "session", id: "session-id", cwd: "/project" },
  { type: "message", message: { role: "user", content: "User first prompt" } },
  assistant(100),
 ]), 0);
 const v = createSessionsView(); v.result = { sessions: [s], more: false };
 expect(renderSessions(v, 120)[0]).toContain("/ filter:");
 sessionsKey(v, "/"); sessionsKey(v, "U");
 expect(renderSessions(v, 120)[0]).toContain("/ filter: U_");
 sessionsKey(v, "\r"); sessionsKey(v, "\r");
 const lines = renderSessions(v, 120);
 expect(lines.slice(0, 3)).toEqual([`${COLORS.bold}Title:${COLORS.reset} User first prompt`, "Session: session-id", "Project: /project"]);
 const detail = stripAnsi(lines.join("\n"));
 expect(detail).not.toContain("/ filter:");
 expect(detail).not.toContain("Esc back · ↑↓ scroll · R refresh");
 expect(detail).not.toContain("Transcript:");
 expect(detail).not.toContain(s.path);
 expect(detail).toContain("Recorded:"); expect(detail).not.toContain("* Pi heuristic;"); expect(detail).not.toContain("Pi tokens:");
 expect(detail).toContain("NODE × PROVIDER"); expect(detail).toContain("Session Requests");
 sessionsKey(v, "\x1b"); expect(renderSessions(v, 120)[0]).toContain("/ filter: U");
});
