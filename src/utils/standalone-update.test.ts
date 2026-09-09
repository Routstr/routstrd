import { describe, expect, test } from "bun:test";
import { expectedChecksum, releaseArchiveName } from "./standalone-update.ts";

describe("releaseArchiveName", () => {
  test("names the Bun-built archive without a suffix", () => {
    expect(releaseArchiveName("0.4.9", "linux", "x64", "bun")).toBe(
      "routstrd-v0.4.9-linux-x64.tar.gz",
    );
    // A leading "v" on the tag must not be doubled.
    expect(releaseArchiveName("v0.4.9", "darwin", "arm64", "bun")).toBe(
      "routstrd-v0.4.9-darwin-arm64.tar.gz",
    );
  });

  // A Deno binary exists because the Bun one does not run on that machine, so
  // it must never update itself to the Bun archive.
  test("names the Deno-built archive with a -deno suffix", () => {
    expect(releaseArchiveName("0.4.9", "linux", "arm64", "deno")).toBe(
      "routstrd-v0.4.9-linux-arm64-deno.tar.gz",
    );
  });

  test("rejects platforms and architectures with no published binary", () => {
    expect(() => releaseArchiveName("0.4.9", "win32", "x64", "bun")).toThrow(
      "not supported on win32",
    );
    expect(() => releaseArchiveName("0.4.9", "linux", "riscv64", "deno")).toThrow(
      "not supported on linux-riscv64",
    );
  });
});

describe("expectedChecksum", () => {
  test("picks the line matching the flavoured archive name", () => {
    const sums = [
      `${"a".repeat(64)}  routstrd-v0.4.9-linux-x64.tar.gz`,
      `${"b".repeat(64)}  routstrd-v0.4.9-linux-x64-deno.tar.gz`,
    ].join("\n");
    expect(expectedChecksum(sums, "routstrd-v0.4.9-linux-x64-deno.tar.gz")).toBe("b".repeat(64));
  });
});
