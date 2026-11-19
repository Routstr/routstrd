import { describe, expect, it } from "bun:test";
import { createBunSqliteUsageTrackingDriver } from "@routstr/sdk/bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryUsageTrackingDriver } from "@routstr/sdk/storage";
import { readSessionIdentity, withSessionIdentity } from "./session-identity";

describe("local session identity", () => {
  it("reads aliases case-insensitively without modifying the request", () => {
    const headers = Object.freeze({ "X-Session-ID": "local-session", "session-id": "other", "x-client-request-id": "request" });
    const metadata = Object.freeze({ sessionId: "metadata", prompt_cache_key: "nested-cache" });
    const body = Object.freeze({ session_id: "body", prompt_cache_key: "cache", metadata });
    expect(readSessionIdentity(headers, body)).toBe("local-session");
  });
  it("does not treat a per-request ID as a session", () => {
    expect(readSessionIdentity({ "X-Client-Request-ID": "per-request-id" }, {})).toBeUndefined();
  });
  it("skips invalid session values when choosing a label to store", () => {
    const headers = Object.freeze({ "x-session-id": "x".repeat(257) });
    expect(readSessionIdentity(headers, {})).toBeUndefined();
    expect(readSessionIdentity(headers, { prompt_cache_key: "cache" })).toBe("cache");
  });
  it("keeps accounting identity local for single and bulk appends", async () => {
    const driver = createMemoryUsageTrackingDriver();
    const wrapped = withSessionIdentity(driver, "local")!;
    const entry = { requestId: "request", id: "one", timestamp: Date.now(), modelId: "test", baseUrl: "https://node", promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0, satsCost: 1 };
    await wrapped.append(entry);
    await wrapped.appendMany([{ ...entry, id: "two" }]);
    expect((await driver.list()).map(entry => entry.sessionId)).toEqual(["local", "local"]);
    expect(withSessionIdentity(driver, undefined)).toBe(driver);
  });
});

it("persists local session identity to SQLite without mixing concurrent requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-accounting-"));
  try {
    const driver = await createBunSqliteUsageTrackingDriver({ dbPath: join(dir, "usage.db") });
    await driver.migrate();
    const entry = { requestId: "req", id: "one", timestamp: Date.now(), modelId: "test", baseUrl: "https://node", promptTokens: 1, completionTokens: 1, totalTokens: 2, cost: 0, satsCost: 1 };
    await Promise.all([
      withSessionIdentity(driver, "session-a")!.append(entry),
      withSessionIdentity(driver, "session-b")!.append({ ...entry, id: "two", requestId: "req-two" }),
      driver.append({ ...entry, id: "three", requestId: "req-three" }),
    ]);
    const rows = await driver.list();
    expect(rows.find(row => row.id === "one")?.sessionId).toBe("session-a");
    expect(rows.find(row => row.id === "two")?.sessionId).toBe("session-b");
    expect(rows.find(row => row.id === "three")?.sessionId).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
