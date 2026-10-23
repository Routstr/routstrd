import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FileRequestResponseLogSink } from "../../src/daemon/request-response-log-sink";

const mode = (path: string): number => statSync(path).mode & 0o777;

describe("request/response log permissions", () => {
  test("log directories are 0700 and log files 0600, also over an existing 0755 dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "routstrd-rrlog-"));
    try {
      mkdirSync(join(root, "requests"), { recursive: true });
      chmodSync(join(root, "requests"), 0o755);
      const sink = new FileRequestResponseLogSink({ dir: root });
      expect(mode(join(root, "requests"))).toBe(0o700);
      expect(mode(join(root, "responses"))).toBe(0o700);

      const id = await sink.logRequest({
        method: "POST",
        url: "http://127.0.0.1/v1/chat/completions",
        path: "/v1/chat/completions",
        baseUrl: "http://127.0.0.1",
        headers: {},
        body: { messages: [{ role: "user", content: "private prompt" }] },
      });
      await sink.logResponseBody(id, new Response("private answer"));

      const files = [
        ...readdirSync(join(root, "requests")).map((f) => join(root, "requests", f)),
        ...readdirSync(join(root, "responses")).map((f) => join(root, "responses", f)),
      ];
      expect(files.length).toBe(2);
      for (const f of files) expect(mode(f)).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
