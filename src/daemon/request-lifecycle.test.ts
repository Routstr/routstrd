import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginRequestLifecycle } from "@routstr/sdk";
import { createBunSqliteRequestLifecycleDriver } from "@routstr/sdk/bun";
import { initializeDaemonLifecycle } from "./request-lifecycle";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "routstrd-lifecycle-owner-"));
  directories.push(dir);
  const dbPath = join(dir, "test.db");
  const driver = await createBunSqliteRequestLifecycleDriver({ dbPath });
  await driver.migrate();
  return { dbPath, driver };
}

describe("daemon lifecycle startup reconciliation", () => {
  it("persists a fresh daemon owner without touching unrelated in-progress rows", async () => {
    const { dbPath, driver } = await fixture();
    const external = await beginRequestLifecycle({ driver, ownerInstanceId: "sdk-owner", method: "POST", path: "/v1/embeddings" });
    const owner = await initializeDaemonLifecycle(driver, dbPath);
    expect(owner).toMatch(/^routstrd:[0-9a-f-]{36}$/);
    expect(await readFile(`${dbPath}.daemon-lifecycle-owner`, "utf8")).toBe(owner);
    expect((await driver.getTrace(external.requestId))?.request.outcome).toBe("in_progress");
  });

  it("interrupts only prior daemon owner's unfinished rows, leaving terminal and other owners alone", async () => {
    const { dbPath, driver } = await fixture();
    const previousOwner = "routstrd:previous-instance";
    await writeFile(`${dbPath}.daemon-lifecycle-owner`, previousOwner);
    const pending = await beginRequestLifecycle({ driver, ownerInstanceId: previousOwner, method: "POST", path: "/v1/chat/completions" });
    const complete = await beginRequestLifecycle({ driver, ownerInstanceId: previousOwner, method: "POST", path: "/v1/chat/completions" });
    await complete.finish({ outcome: "succeeded", httpStatus: 200 });
    const unrelated = await beginRequestLifecycle({ driver, ownerInstanceId: "active-sdk-owner", method: "POST", path: "/v1/chat/completions" });
    const nextOwner = await initializeDaemonLifecycle(driver, dbPath);
    expect(nextOwner).not.toBe(previousOwner);
    expect((await driver.getTrace(pending.requestId))?.request.outcome).toBe("interrupted");
    expect((await driver.getTrace(pending.requestId))?.request.endedAt).toBeNumber();
    expect((await driver.getTrace(complete.requestId))?.request.outcome).toBe("succeeded");
    expect((await driver.getTrace(unrelated.requestId))?.request.outcome).toBe("in_progress");
    // A second startup must not revisit terminal rows from the earlier owner.
    const interrupted = await driver.getTrace(pending.requestId);
    await initializeDaemonLifecycle(driver, dbPath);
    expect((await driver.getTrace(pending.requestId))?.request.endedAt).toBe(interrupted?.request.endedAt);
  });
});
