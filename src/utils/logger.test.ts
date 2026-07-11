import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const testDir = await mkdtemp(join(tmpdir(), "routstrd-logger-"));
const previousRoutstrdDir = process.env.ROUTSTRD_DIR;
process.env.ROUTSTRD_DIR = testDir;
const { getRecentErrors } = await import("./logger.ts");
if (previousRoutstrdDir === undefined) delete process.env.ROUTSTRD_DIR;
else process.env.ROUTSTRD_DIR = previousRoutstrdDir;

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("getRecentErrors", () => {
  it("returns newest errors first, preserves multiline messages, and applies the limit", async () => {
    const logsDir = join(testDir, "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(join(logsDir, "2026-07-10.log"), [
      "[2026-07-10T10:00:00.000Z] [ERROR] older error",
      "older detail",
      "[2026-07-10T11:00:00.000Z] [INFO] ignored",
      "",
    ].join("\n"));
    await writeFile(join(logsDir, "2026-07-11.log"), [
      "[2026-07-11T10:00:00.000Z] [ERROR] newer error",
      "newer detail",
      "[2026-07-11T11:00:00.000Z] [ERROR] newest error",
      "",
    ].join("\n"));

    expect(await getRecentErrors(2)).toEqual([
      { timestamp: "2026-07-11T11:00:00.000Z", message: "newest error" },
      { timestamp: "2026-07-11T10:00:00.000Z", message: "newer error\nnewer detail" },
    ]);

    expect(await getRecentErrors(3)).toEqual([
      { timestamp: "2026-07-11T11:00:00.000Z", message: "newest error" },
      { timestamp: "2026-07-11T10:00:00.000Z", message: "newer error\nnewer detail" },
      { timestamp: "2026-07-10T10:00:00.000Z", message: "older error\nolder detail" },
    ]);
  });
});
