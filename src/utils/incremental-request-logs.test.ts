import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { IncrementalRequestLogs } from "./incremental-request-logs";
import { RequestLogFollower, type LifecycleTrace } from "./request-logs";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(limits?: { requests: number; diagnostics: number; perRequest: number }) {
  const root = mkdtempSync(join(tmpdir(), "incremental-logs-")); roots.push(root);
  return { root, file: join(root, "2026-11-09.log"), reader: new IncrementalRequestLogs(root, limits) };
}
const line = (id = "one", label = "Retrying", suffix = "SECRET") => `[2026-11-09T00:00:00Z] [INFO] [req:${id}:sdk] ${label} ${suffix}\n`;
const records = (r: IncrementalRequestLogs, id = "one") => r.diagnostics([id]).get(id)!;

test("historical scan then idle reads zero bytes; append reads delta plus bounded checkpoint", () => {
  const { file, reader } = setup(); const initial = line().repeat(10000);
  writeFileSync(file, initial); expect(reader.poll().bytesRead).toBe(Buffer.byteLength(initial));
  expect(reader.poll().bytesRead).toBe(0);
  appendFileSync(file, line("two")); expect(reader.poll().bytesRead).toBe(Buffer.byteLength(line("two")) + 256);
  expect(records(reader, "two")).toHaveLength(1);
});
test("unchanged lifecycle emits late safe diagnostics but no payloads", () => {
  const { file, reader } = setup(); writeFileSync(file, "");
  const follower = new RequestLogFollower();
  const traces: LifecycleTrace[] = [{ request: { requestId: "one", startedAt: 0, outcome: "succeeded" }, attempts: [], events: [] }];
  reader.poll(); expect(follower.changed(traces, true, reader.diagnostics(["one"]))).toHaveLength(1);
  expect(follower.changed(traces, true, reader.diagnostics(["one"]))).toHaveLength(0);
  appendFileSync(file, line() + line("one", "Payload", "token=SECRET") + "SECRET continuation\n"); reader.poll();
  const output = follower.changed(traces, true, reader.diagnostics(["one"]));
  expect(output).toHaveLength(1); expect(output[0]).toContain("Retrying"); expect(output[0]).not.toContain("SECRET");
});
test("rollover, truncation, replacement and deletion retain already displayed history", () => {
  const { root, file, reader } = setup(); writeFileSync(file, line()); reader.poll();
  writeFileSync(join(root, "2026-11-10.log"), line("two")); reader.poll(); expect(records(reader, "two")).toHaveLength(1);
  writeFileSync(file, line("one", "Failover", "")); reader.poll(); expect(records(reader)).toHaveLength(2);
  const replacement = join(root, "replace"); writeFileSync(replacement, line()); renameSync(replacement, file); reader.poll(); expect(records(reader)).toHaveLength(3);
  rmSync(file); reader.poll(); expect(records(reader)).toHaveLength(3); expect(reader.poll().bytesRead).toBe(0);
});
test("partial UTF8 and CRLF wait for newline without corrupting request identity", () => {
  const { file, reader } = setup(); const text = line("réquest").replace(/\n$/, "\r\n"); const bytes = Buffer.from(text);
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  writeFileSync(file, bytes.subarray(0, split)); reader.poll(); expect(records(reader, "réquest")).toHaveLength(0);
  appendFileSync(file, bytes.subarray(split, bytes.length - 1)); reader.poll(); expect(records(reader, "réquest")).toHaveLength(0);
  appendFileSync(file, bytes.subarray(-1)); reader.poll(); expect(records(reader, "réquest")).toHaveLength(1);
});
test("cache bounds are explicit, active request preferred and newly selected history indexed", () => {
  const { file, reader } = setup({ requests: 2, diagnostics: 3, perRequest: 2 });
  writeFileSync(file, line("one") + line("two")); reader.poll(["one"]);
  expect(records(reader, "two")).toHaveLength(1); // not initially selected, still indexed
  appendFileSync(file, line("three")); reader.poll(["one"]);
  expect(records(reader)[0]!.message).toContain("Retrying");
  expect(records(reader, "two").at(-1)!.message).toContain("history limited");
  appendFileSync(file, line("one").repeat(5)); reader.poll(["one"]);
  expect(records(reader)).toHaveLength(3); expect(records(reader).at(-1)!.message).toContain("history limited");
});
test("oversized partial lines are bounded and cannot inject continuations", () => {
  const { file, reader } = setup(); writeFileSync(file, "x".repeat(200000));
  expect(reader.poll().warnings).toContain("An oversized diagnostic line was omitted.");
  appendFileSync(file, line() + line("two")); reader.poll();
  expect(records(reader)).toHaveLength(0); expect(records(reader, "two")).toHaveLength(1);
});
test("missing/unreadable directory retries safely", () => {
  const { root } = setup(); const dir = join(root, "missing"); const reader = new IncrementalRequestLogs(dir);
  expect(reader.poll()).toEqual({ bytesRead: 0, warnings: [] });
  writeFileSync(dir, "not a directory"); expect(reader.poll().warnings).toHaveLength(1);
  rmSync(dir); mkdirSync(dir); writeFileSync(join(dir, "2026-11-09.log"), line()); expect(reader.poll().bytesRead).toBeGreaterThan(0);
});

test("untrusted tag lengths cannot bypass cache byte bounds or inject terminal controls", () => {
  const { file, reader } = setup();
  writeFileSync(file, line("x".repeat(300)) + line().replace("[INFO]", `[${"L".repeat(2000)}]`) + line().replace("[INFO]", "[IN\x1bFO]"));
  expect(reader.poll().warnings).toHaveLength(1);
  expect(records(reader)).toHaveLength(1);
  expect(records(reader)[0]!.message).not.toContain("\x1b");
});

test("same-inode truncate/regrow past cursor recovers diagnostics before old offset", () => {
  const { file, reader } = setup(); const old = line("old");
  writeFileSync(file, old); reader.poll();
  const replacement = line("new-first") + line("new-second");
  writeFileSync(file, replacement);
  expect(reader.poll().bytesRead).toBe(Buffer.byteLength(old) + Buffer.byteLength(replacement));
  expect(records(reader, "new-first")).toHaveLength(1);
  expect(records(reader, "new-second")).toHaveLength(1);
  expect(reader.poll().bytesRead).toBe(0);
});

test("truncate/regrow discards an old partial UTF8 line instead of joining new bytes", () => {
  const { file, reader } = setup(); const old = Buffer.from(line("réquest"));
  const split = old.indexOf(Buffer.from("é")) + 1;
  writeFileSync(file, old.subarray(0, split)); reader.poll();
  writeFileSync(file, line("new-first") + line("new-second")); reader.poll();
  expect(records(reader, "réquest")).toHaveLength(0);
  expect(records(reader, "new-first")).toHaveLength(1);
  expect(records(reader, "new-second")).toHaveLength(1);
  expect(reader.poll().bytesRead).toBe(0);
});
