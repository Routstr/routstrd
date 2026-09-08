import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args";

describe("parseArgs", () => {
  test("leaves port unset when no CLI override is provided", () => {
    expect(parseArgs(["routstrd", "daemon"]).port).toBeNull();
  });

  test("parses an explicit port", () => {
    expect(parseArgs(["routstrd", "daemon", "--port", "9000"]).port).toBe(9000);
  });
});
