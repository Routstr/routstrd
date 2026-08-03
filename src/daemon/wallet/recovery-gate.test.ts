import { describe, expect, it } from "bun:test";
import { RecoveryGate } from "./recovery-gate";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("RecoveryGate", () => {
  it("rejects mutations while recovery is running", async () => {
    const gate = new RecoveryGate();
    const hold = deferred();
    const recovery = gate.runRecovery(() => hold.promise);

    await expect(gate.runMutation(async () => undefined)).rejects.toThrow(
      "recovery is in progress",
    );
    hold.resolve();
    await recovery;
  });

  it("rejects concurrent recovery attempts", async () => {
    const gate = new RecoveryGate();
    const hold = deferred();
    const recovery = gate.runRecovery(() => hold.promise);

    await expect(gate.runRecovery(async () => undefined)).rejects.toThrow(
      "already in progress",
    );
    hold.resolve();
    await recovery;
  });

  it("does not start recovery during an active mutation", async () => {
    const gate = new RecoveryGate();
    const hold = deferred();
    const mutation = gate.runMutation(() => hold.promise);

    await expect(gate.runRecovery(async () => undefined)).rejects.toThrow(
      "another wallet operation",
    );
    hold.resolve();
    await mutation;
  });

  it("releases the gate after a failed recovery", async () => {
    const gate = new RecoveryGate();
    await expect(
      gate.runRecovery(async () => {
        throw new Error("restore failed");
      }),
    ).rejects.toThrow("restore failed");

    await expect(gate.runMutation(async () => "ok")).resolves.toBe("ok");
  });
});
