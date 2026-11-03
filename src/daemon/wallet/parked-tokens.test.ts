import { describe, expect, it } from "bun:test";
import {
  recoverParkedTokens,
  type ParkedTokenResult,
  type ParkedTokenSource,
} from "./parked-tokens";

function source(
  recover: () => Promise<ParkedTokenResult[]>,
): ParkedTokenSource & { calls: number } {
  const wrapper = {
    calls: 0,
    getCashuSpender: () => ({
      async recoverCachedReceiveTokens() {
        wrapper.calls += 1;
        return await recover();
      },
    }),
  };
  return wrapper;
}

describe("recoverParkedTokens", () => {
  it("reports how many parked tokens were received", async () => {
    const client = source(async () => [
      { token: "a", success: true },
      { token: "b", success: false },
      { token: "c", success: true },
    ]);

    expect(await recoverParkedTokens(client)).toEqual({
      attempted: 3,
      succeeded: 2,
    });
    expect(client.calls).toBe(1);
  });

  it("reports nothing when the parked list is empty", async () => {
    expect(await recoverParkedTokens(source(async () => []))).toEqual({
      attempted: 0,
      succeeded: 0,
    });
  });

  it("swallows SDK errors so the refund that follows still runs", async () => {
    const recovery = await recoverParkedTokens(
      source(async () => {
        throw new Error("Failed to fetch mint");
      }),
    );

    expect(recovery).toEqual({
      attempted: 0,
      succeeded: 0,
      error: "Failed to fetch mint",
    });
  });
});
