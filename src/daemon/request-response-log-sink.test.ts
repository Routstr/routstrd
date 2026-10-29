import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRequestResponseLogSink } from "./request-response-log-sink";

test("opt-in raw sink links full lifecycle and attempt IDs separately from its own log ID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "routstrd-raw-link-"));
  try {
    const sink = new FileRequestResponseLogSink({ dir });
    const requestId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const id = await sink.logRequest({
      requestId, attemptId, ordinal: 2, method: "POST", path: "/v1/messages",
      url: "https://node.example/v1/messages", baseUrl: "https://node.example",
      headers: { authorization: "Bearer private-credential" }, body: { model: "model" },
    });
    expect(id).toBeString();
    const stored = await readFile(join(dir, "requests", `${id}.json`), "utf8");
    expect(JSON.parse(stored)).toMatchObject({ id, requestId, attemptId, ordinal: 2 });
    expect(id).not.toBe(requestId);
    expect(stored).not.toContain("private-credential");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
