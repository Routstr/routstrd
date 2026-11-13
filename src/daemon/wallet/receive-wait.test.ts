import { Database } from "bun:sqlite";
import { initReceiveDedupSchema, reserveReceiveToken, updateReceiveToken } from "./receive-dedup";
import { describe, expect, it } from "bun:test";
import { waitForReceive } from "./receive-wait";
import { drainRecoveryWork, type RecoveryWork } from "./recovery-work";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe("foreground receive deadline", () => {
  for (const phase of ["prepare", "execute"]) {
    it(`retains ownership and drains late ${phase} settlement after timeout`, async () => {
      const outstanding: RecoveryWork = new Map();
      const blocked = gate();
      const database = new Database(":memory:");
      initReceiveDedupSchema(database);
      let calls = 0;
      let succeeded = false;
      const receive = async () => {
        calls++;
        const reservation = reserveReceiveToken(database, "token");
        expect(reservation.acquired).toBe(true);
        if (phase === "prepare") await blocked.promise;
        updateReceiveToken(database, reservation.tokenHash, { state: "processing", operationId: "receive-1" });
        if (phase === "execute") await blocked.promise;
        updateReceiveToken(database, reservation.tokenHash, { state: "succeeded", operationId: "receive-1" });
        succeeded = true;
        return "received";
      };
      await expect(waitForReceive(outstanding, "token", receive, 5)).rejects.toThrow("Timed out");
      expect(outstanding.size).toBe(1);
      expect(succeeded).toBe(false);
      expect(reserveReceiveToken(database, "token")).toMatchObject({ acquired: false,
        existing: { state: "processing", operationId: phase === "prepare" ? null : "receive-1" } });
      const retry = waitForReceive(outstanding, "token", receive, 1000);
      let drained = false;
      const drain = drainRecoveryWork(outstanding).then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      blocked.resolve();
      expect(await retry).toBe("received");
      await drain;
      expect(calls).toBe(1);
      expect(succeeded).toBe(true);
      expect(outstanding.size).toBe(0);
      expect(reserveReceiveToken(database, "token")).toMatchObject({ acquired: false,
        existing: { state: "succeeded", operationId: "receive-1" } });
      database.close();
    });
  }
  it("observes late failure and permits a subsequent retry", async () => {
    const outstanding: RecoveryWork = new Map();
    const blocked = gate();
    await expect(waitForReceive(outstanding, "token", async () => {
      await blocked.promise;
      throw new Error("mint unavailable");
    }, 5)).rejects.toThrow("Timed out");
    blocked.resolve();
    await drainRecoveryWork(outstanding);
    expect(await waitForReceive(outstanding, "token", async () => "retry")).toBe("retry");
  });
});
