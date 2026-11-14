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
import { createSessionsView, sessionsKey, renderSessions, sessionRequestEntries, sessionModels } from "./sessions-view.ts";
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
  expect(recent.split("\n").slice(1, shared.split("\n").length)).toEqual(shared.split("\n").slice(1));
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

test("Recent transfers canonical estimates only by unique exact response ID", async () => {
 const { recentEstimateIndex, annotateRecent } = await import("./recent-estimates.ts");
 const one = await parseSession(fixture([assistant(0, 7000, 0, "a"), assistant(8000, 0, 0, "b")]), 0);
 const unrelated = await parseSession(fixture([assistant(9000, 0, 0, "first-other")]), 0);
 const index = recentEstimateIndex([one, unrelated]);
 const entries = sessionRequestEntries(one).map(e => ({ ...e, satsCost: 1, promptTokens: e.promptTokens!, completionTokens: e.completionTokens! }));
 // Modern SDK lifecycle request ID differs from the response ID.
 Object.assign(entries[0]!, { requestId: "lifecycle", upstreamResponseId: "b" });
 const annotated = annotateRecent(entries, index, true);
 expect(annotated[0]!.estimatedMissedTokens).toBe(7000);
 expect(annotated[1]!.estimatedMissedTokens).toBeUndefined(); // first turn
 expect(index.has("first-other")).toBe(false); // never use another session as predecessor
 const shared = renderRequestTable(sessionRequestEntries(one), 160, emptyClientNaming());
 const recent = renderRequestTable(annotated, 160, emptyClientNaming());
 const red = (s: string) => [...s.matchAll(/\x1b\[31m(█+)/g)].map(m => m[1]);
 expect(red(recent)).toEqual(red(shared)); expect(red(recent).length).toBeGreaterThan(0);
 expect(annotateRecent(entries, index, false)[0]!.estimatedMissedTokens).toBeUndefined();
 expect(annotateRecent([entries[0]!, entries[0]!], index, true).every(e => e.estimatedMissedTokens === undefined)).toBe(true);
 const duplicate = structuredClone(one); expect(recentEstimateIndex([one, duplicate]).has("b")).toBe(false);
 const invalid = structuredClone(one); invalid.warnings.push("incomplete"); expect(recentEstimateIndex([invalid]).size).toBe(0);
 const absent = { ...entries[0]!, requestId: "absent", upstreamResponseId: "" };
 expect(annotateRecent([absent], index, true)[0]!.estimatedMissedTokens).toBeUndefined();
 const refreshed = structuredClone(one); refreshed.turns[1]!.missed = 5000;
 expect(annotateRecent(entries, recentEstimateIndex([refreshed]), true)[0]!.estimatedMissedTokens).toBe(5000);
 const rendered = stripAnsi(renderRecent({ entries: annotated } as unknown as UsageStats, 160, emptyClientNaming()));
 expect(rendered).toContain("Pi miss estimates: 1/2 eligible exact matches");
 expect(rendered).toContain("not proven zero");
});

test("Recent async canonical loading and refresh are independent of Sessions visits", async () => {
 const child = Bun.spawn(["bun", join(import.meta.dir, "recent-dispatch-smoke.ts")], { stdout: "pipe", stderr: "pipe" });
 const err = await new Response(child.stderr).text();
 expect(err).toContain("Recent async dispatch OK"); expect(await child.exited).toBe(0);
});

test("Sessions list uses shared boxed rows with selection/filter and bounded widths", async () => {
 const s = await parseSession(fixture([{ type: "session", id: "s", cwd: "/project" }, { type: "message", message: { role: "user", content: "A long first user prompt for the session list" } }, assistant(0, 7000), assistant(8000)]), 0);
 s.turns[0]!.sats = 1.25;
 const v = createSessionsView(); v.result = { sessions: Array.from({length: 30}, (_, i) => ({...s, id: `s${i}`})), more: true };
 for (const width of [40,80,120,160]) {
  const list = renderSessions(v,width,20);
  const box = list.filter(l => /^[┌│└]/.test(l));
  expect(stripAnsi(box[0]!)).toContain("Sessions (30 shown)");
  expect(box[1]).toContain(COLORS.bold);
  for (const line of box) expect(stripAnsi(line).length).toBe(width);
  expect(box.filter(l => stripAnsi(l).startsWith("│ >"))).toHaveLength(1);
  expect(list.join("\n")).toContain("More sessions available: M");
  expect(stripAnsi(box.join("\n"))).toContain("1.25+?");
 }
 for (let i=0;i<25;i++) sessionsKey(v,"j");
 const page = renderSessions(v,120,20);
 expect(page.filter(l => stripAnsi(l).startsWith("│ >"))).toHaveLength(1);
 expect(v.selected).toBe(25);
 sessionsKey(v,"/"); sessionsKey(v,"z"); sessionsKey(v,"\r");
 expect(renderSessions(v,80).join("\n")).toContain("No sessions match");
});

test("Sessions Models lists unique actual assistant model IDs in encounter order", async () => {
 const s = await parseSession(fixture([assistant(100), assistant(200), assistant(300), assistant(400)]), 0);
 s.turns[0]!.model = "gpt-6.1-sol"; s.turns[1]!.model = "deepseek-v4.1-flash";
 s.turns[2]!.model = "gpt-6.1-sol"; s.turns[3]!.model = "";
 expect(sessionModels(s)).toBe("gpt-6.1-sol, deepseek-v4.1-flash");
 const v = createSessionsView(); v.result = { sessions: [s], more: false };
 for (const width of [40,80,120,160]) {
  const lines = renderSessions(v,width).filter(l => /^[┌│└]/.test(l));
  for (const l of lines) expect(stripAnsi(l).length).toBe(width);
  expect(lines.filter(l => stripAnsi(l).startsWith("│ >"))).toHaveLength(1);
  if (width >= 80) expect(stripAnsi(lines[1]!)).toContain("Models");
  if (width === 160) expect(stripAnsi(lines.join("\n"))).toContain("gpt-6.1-sol, deepseek-v4.1-flash");
  if (width === 120) expect(stripAnsi(lines.join("\n"))).toContain("gpt-6.1-sol,");
 }
 s.turns.forEach(t => { t.model = "Unknown"; }); expect(sessionModels(s)).toBe("—");
 s.turns = []; expect(sessionModels(s)).toBe("—");
});

test("Sessions excludes only explicit zero-usage unaccounted failures after canonical scan", async () => {
 const { visibleSessionTurns } = await import("./sessions-data.ts");
 const failure = (id: string | undefined, reason = "error", input = 0) => {
  const e = assistant(input, 0, 0, id); e.message.usage.output = 0;
  Object.assign(e.message, { responseId: id, stopReason: reason }); return e;
 };
 const s = await parseSession(fixture([
  failure(undefined), // local import error
  failure(undefined), // upstream 502
  failure(undefined,"aborted"),
  failure("terminated"),
  failure("positive", "error", 7000),
  failure("billed"),
  failure(undefined,"stop"), // success without ID is not a failure
  assistant(0,7000,0,"cached"), failure("positive-miss","error",8000),
 ]),0);
 const db = new Database(":memory:"); db.exec("CREATE TABLE usage_tracking(request_id TEXT, sats_cost REAL); INSERT INTO usage_tracking VALUES ('billed',2)");
 attributeUsage(s,db); db.close();
 const visible = visibleSessionTurns(s);
 expect(visible).toHaveLength(5);
 expect(visible.map(t=>t.responseId)).toEqual(["positive","billed",undefined,"cached","positive-miss"]);
 expect(s.turns[8]!.missed).toBe(7000); // positive error participated before presentation filtering
 const v=createSessionsView(); v.result={sessions:[s],more:false};v.detail=true;
 const detail=stripAnsi(renderSessions(v,160).join("\n"));
 expect(detail).toContain("4 failed attempts; spend unknown"); expect(detail).toContain("priced 1/9 · matched 1/9");
 expect(detail).toContain("Session Requests (5 shown)"); expect(detail).not.toContain("terminated");
 expect(detail).toContain("positive"); expect(detail).toContain("no response ID");
 expect(sessionRequestEntries(s)).toHaveLength(5);
 // Unknown usage or duplicate/ambiguous accounting is retained conservatively.
 const unknown=structuredClone(s.turns[0]!); unknown.prompt=null;
 const ambiguous=structuredClone(s.turns[0]!); ambiguous.match="ambiguous";
 expect(visibleSessionTurns({...s,turns:[unknown,ambiguous]})).toHaveLength(2);
});

test("only narrow local module-loader failures leave coverage; transport failures keep unknown spend", async () => {
 const { accountingSessionTurns, localPreSendFailure } = await import("./sessions-data.ts");
 const localText = "Cannot find module '/home/user/.pi/node_modules/@earendil-works/pi-ai/dist/providers/openai-responses.js'";
 const fail = (errorMessage: string, reason = "error") => {
  const e = assistant(0); e.message.usage.output = 0;
  Object.assign(e.message, { responseId: undefined, stopReason: reason, errorMessage }); return e;
 };
 const s = await parseSession(fixture([
  fail(localText), fail("Request timed out"), fail("Connection reset"), fail("502 Bad Gateway"),
  fail("Aborted", "aborted"), fail("terminated"), fail("Cannot import local openai-responses module"),
  fail("Upstream: " + localText), fail("Cannot find module 'openai-responses'"),
 ]),0);
 expect(s.turns.map(localPreSendFailure)).toEqual([true,false,false,false,false,false,false,false,false]);
 expect(accountingSessionTurns(s)).toHaveLength(8);
 expect(sessionRequestEntries(s)).toHaveLength(0);
 const billed = structuredClone(s.turns[0]!); billed.match="matched"; billed.sats=2;
 expect(localPreSendFailure(billed)).toBe(false);
 const id = structuredClone(s.turns[0]!); id.responseId="sent"; expect(localPreSendFailure(id)).toBe(false);
 const usage = structuredClone(s.turns[0]!); usage.prompt=1; expect(localPreSendFailure(usage)).toBe(false);
 s.turns.push(billed);
 const v=createSessionsView(); v.result={sessions:[s],more:false};
 expect(stripAnsi(renderSessions(v,160).join("\n"))).toContain("2.00+?");
 v.detail=true; const detail=stripAnsi(renderSessions(v,160).join("\n"));
 expect(detail).toContain("priced 1/9 · matched 1/9");
 expect(detail).toContain("1 local pre-send failures excluded");
 expect(detail).toContain("8 failed attempts; spend unknown");
 expect(detail).toContain("Recorded: 2.00+? sats");
 expect(detail).toContain("Session Requests (1 shown)");
 const onlyLocal={...s,turns:[s.turns[0]!]}; v.result={sessions:[onlyLocal],more:false};
 const local=stripAnsi(renderSessions(v,160).join("\n")); expect(local).toContain("priced 0/0"); expect(local).not.toContain("spend unknown");
});

test("explicit Bunkhouse sources merge before limits, unwrap titles and deduplicate copies", async () => {
 const root = mkdtempSync(join(tmpdir(), "pi-sources-")); dirs.push(root);
 const normal = join(root, "normal"), extra = join(root, "chat");
 mkdirSync(join(normal, "project"), {recursive: true}); mkdirSync(extra);
 const framed = '<context>private context</context>\n<conversation-context>old <message>wrong</message></conversation-context>\n<message from="sender">Actual\nchat request</message>';
 const entries = [{type:"session",id:"chat-id",cwd:"/workspaces/main-2"}, {type:"message",message:{role:"user",content:[{type:"text",text:framed}]}}, assistant(100, 3000, 0, "warm"), assistant(4000, 0, 0, "miss")];
 const chat = join(extra,"chat.jsonl"); writeFileSync(chat, entries.map(e=>JSON.stringify(e)).join("\n"));
 writeFileSync(join(normal,"project","normal.jsonl"), JSON.stringify({type:"session",id:"normal",cwd:"/repo"}));
 const { utimesSync, copyFileSync } = await import("node:fs");
 utimesSync(join(normal,"project","normal.jsonl"), new Date(1000), new Date(1000));
 const dbPath=join(root,"usage.db"), db=new Database(dbPath);
 db.run("CREATE TABLE usage_tracking (request_id TEXT, upstream_response_id TEXT, sats_cost REAL, base_url TEXT, provider TEXT)");
 db.run("INSERT INTO usage_tracking VALUES ('life','miss',2.5,'https://node/','provider')"); db.close();
 const sources = [{path:extra,kind:"bunkhouse" as const,label:"Bunkhouse · main-2"}, {path:extra,kind:"bunkhouse" as const}, {path:join(root,"missing"),kind:"pi" as const}];
 const loader=new SessionsLoader(normal,dbPath,sources);
 const page=await loader.load(1);
 expect(page.sessions).toHaveLength(1); expect(page.more).toBe(true);
 const session=page.sessions[0]!;
 expect(session.title).toBe("Actual chat request"); expect(session.cwd).toBe("/workspaces/main-2");
 expect(session.sourceLabel).toBe("Bunkhouse · main-2");
 expect(session.turns[1]!.missed).toBe(3100); expect(session.turns[1]!.sats).toBe(2.5);
 expect(page.error).toContain("source unavailable");
 const {recentEstimateIndex}=await import("./recent-estimates.ts");
 expect(recentEstimateIndex([session]).size).toBeGreaterThan(0);
 const {annotateRecent}=await import("./recent-estimates.ts");
 const recent=annotateRecent([{requestId:"lifecycle",upstreamResponseId:"miss"} as any],recentEstimateIndex([session]),true);
 expect(recent[0]!.estimatedMissedTokens).toBe(sessionRequestEntries(session)[0]!.estimatedMissedTokens);
 const missingDefault=await new SessionsLoader(join(root,"absent-default"),dbPath,[sources[0]!]).load(20);
 expect(missingDefault.sessions[0]!.title).toBe("Actual chat request");
 const full=await loader.load(20); expect(full.sessions).toHaveLength(2);
 copyFileSync(chat,join(extra,"copy.jsonl"));
 expect((await loader.load(20)).sessions).toHaveLength(2);
 const standard=await parseSession(chat,0);
 expect(standard.title).toContain("<context>");
});

test("source config validates only typed absolute paths without exposing config contents", async () => {
 const root=mkdtempSync(join(tmpdir(),"source-config-")); dirs.push(root);
 const old=process.env.ROUTSTRD_DIR; process.env.ROUTSTRD_DIR=root;
 try {
  const {configuredSessionSources}=await import("./sessions-data.ts");
  writeFileSync(join(root,"config.json"),JSON.stringify({secret:"never-print",sessionSources:[{path:"relative",kind:"pi"},{path:"/chat",kind:"bunkhouse",label:"Chat"},{path:"/state",kind:"bunkhouse-state"},{path:"/bad",kind:"other"}]}));
  const warnings:string[]=[];
  expect(await configuredSessionSources(warnings)).toEqual([{path:"/chat",kind:"bunkhouse",label:"Chat"},{path:"/state",kind:"bunkhouse-state",label:undefined}]);
  expect(warnings.length).toBe(2); expect(warnings.join()).not.toContain("never-print");
  writeFileSync(join(root,"config.json"),"invalid secret");
  expect(await configuredSessionSources(warnings)).toEqual([]);
  expect(warnings.join()).not.toContain("invalid secret");
 } finally { if(old===undefined) delete process.env.ROUTSTRD_DIR; else process.env.ROUTSTRD_DIR=old; }
});

test("Bunkhouse state root discovers fixed bot/group layouts and new groups on refresh", async () => {
 const root=mkdtempSync(join(tmpdir(),"bunk-state-")); dirs.push(root);
 const state=join(root,"state"), normal=join(root,"normal"), dbPath=join(root,"usage.db");
 const db=new Database(dbPath); db.run("CREATE TABLE usage_tracking (request_id TEXT, sats_cost REAL)"); db.close();
 function chat(bot:string,group:string,id:string) {
  const path=join(state,bot,"pi",group,"sessions"); mkdirSync(path,{recursive:true});
  writeFileSync(join(path,id+".jsonl"),[
   {type:"session",id,cwd:"/work/"+group},
   {type:"message",message:{role:"user",content:"<context>hidden</context><message>First chat request</message>"}},
   assistant(100,3000,0,id+"-warm"),assistant(4000,0,0,id+"-miss")
  ].map(e=>JSON.stringify(e)).join("\n")); return path;
 }
 const first=chat("assistant","main","one"); chat("helper","main-2--throwaway-1","two");
 const source={path:state,kind:"bunkhouse-state" as const};
 const loader=new SessionsLoader(normal,dbPath,[source,{path:first,kind:"bunkhouse"}]);
 const initial=await loader.load(1); expect(initial.sessions).toHaveLength(1); expect(initial.more).toBe(true);
 let page=await loader.load(); expect(page.sessions).toHaveLength(2);
 expect(page.sessions.map(s=>s.sourceLabel).sort()).toEqual(["Bunkhouse · assistant · main","Bunkhouse · helper · main-2--throwaway-1"]);
 expect(page.sessions.every(s=>s.title==="First chat request")).toBe(true);
 expect(page.sessions[0]!.turns[1]!.missed).toBe(3100);
 chat("assistant","new-room","three");
 page=await loader.load(); expect(page.sessions).toHaveLength(3);
 const {symlinkSync}=await import("node:fs");
 const outside=join(root,"outside"); mkdirSync(outside); symlinkSync(outside,join(state,"linked-bot"));
 symlinkSync(first,join(state,"assistant","pi","linked-room"));
 symlinkSync(join(first,"one.jsonl"),join(first,"linked.jsonl"));
 page=await loader.load(); expect(page.sessions).toHaveLength(3);
 const missing=await new SessionsLoader(normal,dbPath,[{path:join(root,"absent"),kind:"bunkhouse-state"}]).load();
 expect(missing.error).toContain("state root unavailable");
 const {expandSessionSources,SOURCE_DISCOVERY_LIMITS}=await import("./sessions-data.ts");
 const old=SOURCE_DISCOVERY_LIMITS.directories;
 try {
  SOURCE_DISCOVERY_LIMITS.directories=2;
  const warnings:string[]=[]; await expandSessionSources([source],warnings);
  expect(warnings.join()).toContain("results incomplete");
 } finally { SOURCE_DISCOVERY_LIMITS.directories=old; }
});
