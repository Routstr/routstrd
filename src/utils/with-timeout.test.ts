import { describe, expect, test } from "bun:test";
import { withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  test("passes through a settled value", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "nope")).resolves.toBe(
      42,
    );
  });

  test("rejects with the provided message once the deadline elapses", async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 20, "operation timed out")).rejects.toThrow(
      "operation timed out",
    );
  });

  test("propagates the original rejection", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 1000, "unused"),
    ).rejects.toThrow("boom");
  });
});
