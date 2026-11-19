import { describe, expect, it } from "bun:test";
import { MintRestoreGate } from "./mint-restore-gate";

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

describe("MintRestoreGate", () => {
  it("rejects mutations while a restore is running", async () => {
    const gate = new MintRestoreGate();
    const hold = deferred();
    const restore = gate.runRestore(() => hold.promise);

    await expect(gate.runMutation(async () => undefined)).rejects.toThrow(
      "restore is in progress",
    );
    hold.resolve();
    await restore;
  });

  it("rejects concurrent restore attempts", async () => {
    const gate = new MintRestoreGate();
    const hold = deferred();
    const restore = gate.runRestore(() => hold.promise);

    await expect(gate.runRestore(async () => undefined)).rejects.toThrow(
      "already in progress",
    );
    hold.resolve();
    await restore;
  });

  it("does not start a restore during an active mutation", async () => {
    const gate = new MintRestoreGate();
    const hold = deferred();
    const mutation = gate.runMutation(() => hold.promise);

    await expect(gate.runRestore(async () => undefined)).rejects.toThrow(
      "another wallet operation",
    );
    hold.resolve();
    await mutation;
  });

  it("releases the gate after a failed restore", async () => {
    const gate = new MintRestoreGate();
    await expect(
      gate.runRestore(async () => {
        throw new Error("restore failed");
      }),
    ).rejects.toThrow("restore failed");

    await expect(gate.runMutation(async () => "ok")).resolves.toBe("ok");
  });

  it("allows sequential mutations once no restore runs", async () => {
    const gate = new MintRestoreGate();
    const order: string[] = [];
    await Promise.all([
      gate.runMutation(async () => {
        order.push("a");
      }),
      gate.runMutation(async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a", "b"]);
  });
});
