/** Synthetic, no daemon/network/funds. Run: bun scripts/benchmark-request-log-follow.ts */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { IncrementalRequestLogs } from "../src/utils/incremental-request-logs";
const root = mkdtempSync(join(tmpdir(), "log-follow-bench-"));
try {
  const line = "[2026-11-09T00:00:00Z] [INFO] [req:fixture] Retrying synthetic detail\n";
  const data = line.repeat(100000);
  for (let day = 1; day <= 16; day++) writeFileSync(join(root, `2026-11-${String(day).padStart(2, "0")}.log`), data);
  const reader = new IncrementalRequestLogs(root);
  const start = performance.now(); const initial = reader.poll(["fixture"]);
  const initialMs = performance.now() - start;
  const idleStart = performance.now(); let idleBytes = 0;
  for (let i = 0; i < 20; i++) idleBytes += reader.poll(["fixture"]).bytesRead;
  const idleMs = performance.now() - idleStart;
  appendFileSync(join(root, "2026-11-16.log"), line);
  console.log(JSON.stringify({ initialBytes: initial.bytesRead, initialMs: Math.round(initialMs), idlePolls: 20, idleBytes,
    idleMs: Math.round(idleMs), appendBytes: reader.poll(["fixture"]).bytesRead, newBytes: Buffer.byteLength(line), checkpointBytes: 256, expectedAppendReadBytes: Buffer.byteLength(line) + 256,
    cachedDiagnostics: reader.diagnostics(["fixture"]).get("fixture")!.length, rssMiB: Math.round(process.memoryUsage().rss / 1048576) }, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
