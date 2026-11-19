import { describe, expect, it } from "bun:test";
import { createBunSqliteUsageTrackingDriver } from "@routstr/sdk/bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryUsageTrackingDriver } from "@routstr/sdk/storage";
import { consumeSessionIdentity, withSessionIdentity } from "./session-identity";

describe("local session identity", () => {
  it("consumes aliases case-insensitively without changing unrelated data", () => {
    const headers: Record<string, string> = { "X-Session-ID": "local-session", "session-id": "other", session_id: "other", "x-client-request-id": "other", "x-session-affinity": "other", "x-opencode-session": "other", authorization: "Bearer test", "x-request-id": "request" };
    const body: Record<string, unknown> = { session_id: "body", sessionId: "body", prompt_cache_key: "body", model: "test", messages: [{ content: "session_id is ordinary prompt text" }] };
    expect(consumeSessionIdentity(headers, body)).toBe("local-session");
    expect(headers).toEqual({ authorization: "Bearer test", "x-request-id": "request" });
    expect(body).toEqual({ model: "test", messages: [{ content: "session_id is ordinary prompt text" }] });
  });
  it("strips a standalone per-request ID without treating it as a session", () => {
    const headers: Record<string, string> = { "X-Client-Request-ID": "per-request-id" };
    expect(consumeSessionIdentity(headers, {})).toBeUndefined();
    expect(headers).toEqual({});
  });
  it("removes invalid identity without storing it", () => {
    const headers: Record<string, string> = { "x-session-id": "x".repeat(257) };
    expect(consumeSessionIdentity(headers, {})).toBeUndefined();
    expect(headers).toEqual({});
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
