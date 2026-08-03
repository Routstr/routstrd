import { describe, expect, it } from "bun:test";
import type { initializeCoco } from "@cashu/coco-core";
import { recoverMintProofs } from "./coco-client";

type CocoManager = Awaited<ReturnType<typeof initializeCoco>>;

function manager(options: { restoreError?: Error } = {}): {
  coco: CocoManager;
  calls: string[];
} {
  const calls: string[] = [];
  const record = (name: string) => async () => {
    calls.push(name);
  };
  const coco = {
    mint: {
      addMint: async (url: string, addOptions: { trusted: boolean }) => {
        calls.push(`add:${url}:${addOptions.trusted}`);
        return { keysets: [{}, {}] };
      },
    },
    wallet: {
      restore: async (url: string) => {
        calls.push(`restore:${url}`);
        if (options.restoreError) throw options.restoreError;
      },
    },
    pauseSubscriptions: record("pause-subscriptions"),
    disableMintOperationWatcher: record("stop-mint-watcher"),
    disableProofStateWatcher: record("stop-proof-watcher"),
    disableMintOperationProcessor: record("stop-mint-processor"),
    enableMintOperationWatcher: record("start-mint-watcher"),
    enableProofStateWatcher: record("start-proof-watcher"),
    enableMintOperationProcessor: async () => {
      calls.push("start-mint-processor");
      return true;
    },
    resumeSubscriptions: record("resume-subscriptions"),
  } as unknown as CocoManager;
  return { coco, calls };
}

describe("recoverMintProofs", () => {
  it("normalizes the mint URL, restores it, and emits coarse progress", async () => {
    const { coco, calls } = manager();
    const progress: string[] = [];

    const result = await recoverMintProofs(
      coco,
      "https://mint.example.com/",
      (message) => progress.push(message),
    );

    expect(calls).toContain("add:https://mint.example.com:true");
    expect(calls).toContain("restore:https://mint.example.com");
    expect(progress).toHaveLength(3);
    expect(progress[1]).toContain("2 keyset(s)");
    expect(result).toContain("https://mint.example.com");
  });

  it("restarts background services when restore fails", async () => {
    const { coco, calls } = manager({ restoreError: new Error("restore failed") });

    await expect(
      recoverMintProofs(coco, "https://mint.example.com"),
    ).rejects.toThrow("restore failed");

    expect(calls).toContain("start-mint-watcher");
    expect(calls).toContain("start-proof-watcher");
    expect(calls).toContain("start-mint-processor");
    expect(calls).toContain("resume-subscriptions");
  });
});
