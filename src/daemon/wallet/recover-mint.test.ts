import { describe, expect, it } from "bun:test";
import type { CoreProof, Manager } from "@cashu/coco-core";
import { describeRestoreError, recoverMintProofs } from "./coco-client";

function proof(
  keysetId: string,
  secret: string,
  amount = 1,
  state: CoreProof["state"] = "ready",
): CoreProof {
  return {
    id: keysetId,
    amount,
    secret,
    C: "02" + "11".repeat(32),
    state,
    mintUrl: "https://mint.example.com",
  } as CoreProof;
}

type FakeOptions = {
  /** Keysets the mint advertises. */
  keysetIds?: string[];
  /** What the mint returns per keyset (any state; spent ones are not saved). */
  mintProofs?: Record<string, CoreProof[]>;
  /** Proofs already stored locally, per keyset id, in any state. */
  stored?: Record<string, CoreProof[]>;
  /** Proofs left inflight, per mint. */
  inflight?: CoreProof[];
  restoreError?: (keysetId: string) => Error | undefined;
};

/**
 * Mirrors coco-core 1.0.1 / coco-sqlite-bun closely enough to reproduce the
 * failure modes this code exists to handle:
 *  - `getProofsByKeysetId()` returns READY proofs only,
 *  - `saveProofs()` rejects a secret that is already stored in ANY state,
 *  - `wipeProofsByKeysetId()` deletes every row for the keyset.
 */
function fakeManager(options: FakeOptions = {}) {
  const keysetIds = options.keysetIds ?? ["ks1", "ks2"];
  const stored = new Map<string, CoreProof[]>(
    Object.entries(options.stored ?? {}).map(([id, proofs]) => [
      id,
      proofs.map((p) => ({ ...p })),
    ]),
  );
  const calls: string[] = [];
  const record = (name: string) => async () => {
    calls.push(name);
  };

  const allStored = (): CoreProof[] => [...stored.values()].flat();

  const proofService = {
    async getProofsByKeysetId(_mintUrl: string, keysetId: string) {
      return (stored.get(keysetId) ?? []).filter(
        (p) => p.state === "ready",
      );
    },
    async wipeProofsByKeysetId(_mintUrl: string, keysetId: string) {
      calls.push(`wipe:${keysetId}`);
      stored.set(keysetId, []);
    },
    async saveProofs(_mintUrl: string, proofs: CoreProof[]) {
      for (const incoming of proofs) {
        const clash = allStored().find((p) => p.secret === incoming.secret);
        if (clash) {
          throw new Error(`Proof with secret already exists: ${incoming.secret}`);
        }
      }
      for (const incoming of proofs) {
        const keysetId = incoming.id;
        stored.set(keysetId, [...(stored.get(keysetId) ?? []), incoming]);
        calls.push(`save:${keysetId}:${incoming.secret}`);
      }
    },
  };

  const coco = {
    mint: {
      addMint: async (url: string, addOptions: { trusted: boolean }) => {
        calls.push(`add:${url}:${addOptions.trusted}`);
        return { keysets: keysetIds.map((id) => ({ id })) };
      },
    },
    walletService: {
      getWalletWithActiveKeysetId: async (url: string) => {
        calls.push(`wallet:${url}`);
        return { wallet: {} };
      },
    },
    walletRestoreService: {
      restoreKeyset: async (
        _url: string,
        _wallet: unknown,
        keysetId: string,
      ) => {
        calls.push(`restore:${keysetId}`);
        const error = options.restoreError?.(keysetId);
        if (error) throw error;
        const returned = options.mintProofs?.[keysetId] ?? [];
        // coco persists only the proofs the mint reports as unspent.
        await proofService.saveProofs(
          "https://mint.example.com",
          returned.filter((p) => p.state !== "spent"),
        );
      },
    },
    proofService,
    proofRepository: {
      async getInflightProofs(_mintUrls?: string[]) {
        return options.inflight ?? [];
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
  } as unknown as Manager;

  return { coco, calls, stored };
}

describe("recoverMintProofs", () => {
  it("wipes spent and inflight rows before saving the restored batch", async () => {
    // Regression: `getProofsByKeysetId` hides spent/inflight rows, so a
    // ready-only wipe left their secrets behind and saveProofs rejected the
    // restored copy with "Proof with secret already exists".
    const inflight = proof("ks1", "inflight-1", 8, "inflight");
    const { coco, calls, stored } = fakeManager({
      keysetIds: ["ks1"],
      stored: {
        ks1: [inflight, proof("ks1", "spent-1", 4, "spent")],
      },
      inflight: [inflight],
      mintProofs: {
        ks1: [
          proof("ks1", "fresh-1", 8),
          proof("ks1", "spent-1", 4, "spent"),
        ],
      },
    });
    const progress: string[] = [];

    const result = await recoverMintProofs(
      coco,
      "https://mint.example.com",
      (message) => progress.push(message),
    );

    expect(calls).toContain("wipe:ks1");
    expect(stored.get("ks1")?.map((p) => p.secret)).toEqual(["fresh-1"]);
    expect(result).toContain("8 sat");
    expect(progress.some((line) => line.includes("restoring"))).toBe(true);
  });

  it("keeps local proofs when the restore fails partway", async () => {
    const { coco, calls, stored } = fakeManager({
      keysetIds: ["ks1"],
      stored: { ks1: [proof("ks1", "s1")] },
      restoreError: () => new Error("mint unreachable"),
    });

    await expect(
      recoverMintProofs(coco, "https://mint.example.com"),
    ).rejects.toThrow("mint unreachable");

    expect(stored.get("ks1")?.map((p) => p.secret)).toEqual(["s1"]);
    expect(calls).toContain("start-mint-watcher");
    expect(calls).toContain("resume-subscriptions");
  });

  it("restores inflight proofs back on a failed restore", async () => {
    // Inflight proofs hold value too, so the snapshot cannot be ready-only.
    const inflight = proof("ks1", "inflight-1", 8, "inflight");
    const { coco, stored } = fakeManager({
      keysetIds: ["ks1"],
      stored: { ks1: [inflight] },
      inflight: [inflight],
      restoreError: () => new Error("mint unreachable"),
    });

    await expect(
      recoverMintProofs(coco, "https://mint.example.com"),
    ).rejects.toThrow("mint unreachable");

    expect(stored.get("ks1")?.map((p) => p.secret)).toEqual(["inflight-1"]);
  });

  it("accepts a restore where the mint reports everything spent", async () => {
    // The mint is authoritative: it returned signatures (so the restore was
    // not truncated) but none are unspent, so dropping the local rows is the
    // correct outcome, not a failure to roll back.
    const { coco, stored } = fakeManager({
      keysetIds: ["ks1"],
      stored: { ks1: [proof("ks1", "s1"), proof("ks1", "s2")] },
      mintProofs: {
        ks1: [
          proof("ks1", "s1", 1, "spent"),
          proof("ks1", "s2", 1, "spent"),
        ],
      },
    });

    const result = await recoverMintProofs(coco, "https://mint.example.com");

    expect(result).toContain("0 sat");
    expect(stored.get("ks1")).toEqual([]);
  });

  it("skips a keyset the mint no longer serves when nothing is stored", async () => {
    const { coco } = fakeManager({
      keysetIds: ["retired"],
      restoreError: () => new Error("422: keyset not known"),
    });

    const progress: string[] = [];
    const result = await recoverMintProofs(
      coco,
      "https://mint.example.com",
      (message) => progress.push(message),
    );

    expect(
      progress.some((line) => line.includes("skipped (no local proofs")),
    ).toBe(true);
    expect(result).toContain("0 sat");
  });

  it("reports a failed keyset without discarding a successful one", async () => {
    const { coco, stored } = fakeManager({
      keysetIds: ["bad", "good"],
      stored: { bad: [proof("bad", "b1")] },
      mintProofs: { good: [proof("good", "g1")] },
      restoreError: (keysetId) =>
        keysetId === "bad" ? new Error("mint unreachable") : undefined,
    });

    await expect(
      recoverMintProofs(coco, "https://mint.example.com"),
    ).rejects.toThrow("Failed to restore 1 of 2 keyset(s)");

    expect(stored.get("bad")?.map((p) => p.secret)).toEqual(["b1"]);
    expect(stored.get("good")?.map((p) => p.secret)).toEqual(["g1"]);
  });

  it("refuses to wipe proofs a live operation still owns", async () => {
    const { coco, calls } = fakeManager({
      keysetIds: ["ks1"],
      stored: { ks1: [proof("ks1", "s1")] },
      inflight: [
        {
          ...proof("ks1", "s9", 1, "inflight"),
          usedByOperationId: "op_executing",
        } as CoreProof,
      ],
    });

    await expect(
      recoverMintProofs(coco, "https://mint.example.com"),
    ).rejects.toThrow(
      "reserved by operations that are still open (op_executing)",
    );

    expect(calls.some((call) => call.startsWith("wipe:"))).toBe(false);
  });

  it("reconciles orphaned inflight proofs instead of blocking", async () => {
    const orphan = proof("ks1", "orphan-1", 1, "inflight");
    const { coco, calls, stored } = fakeManager({
      keysetIds: ["ks1"],
      stored: { ks1: [orphan] },
      inflight: [orphan],
      mintProofs: { ks1: [proof("ks1", "orphan-1")] },
    });
    const progress: string[] = [];

    const result = await recoverMintProofs(
      coco,
      "https://mint.example.com",
      (message) => progress.push(message),
    );

    expect(progress.some((line) => line.includes("left inflight"))).toBe(true);
    expect(calls).toContain("wipe:ks1");
    expect(stored.get("ks1")?.map((p) => p.secret)).toEqual(["orphan-1"]);
    expect(result).toContain("1 sat");
  });

  it("refuses to run when coco's restore internals are missing", async () => {
    const coco = {
      mint: { addMint: async () => ({ keysets: [] }) },
    } as unknown as Manager;

    await expect(
      recoverMintProofs(coco, "https://mint.example.com"),
    ).rejects.toThrow("coco mint-restore internals are unavailable");
  });
});

describe("describeRestoreError", () => {
  it("walks the cause chain and nested aggregate errors", () => {
    const inner = new Error("Proof with secret already exists: abcd");
    const aggregate = new AggregateError([inner], "aggregated");
    const outer = new Error(
      "Failed to persist proofs for 1 keyset group(s) [ks1]",
      { cause: aggregate },
    );

    const message = describeRestoreError(outer);
    expect(message).toContain("Failed to persist proofs");
    expect(message).toContain("Proof with secret already exists: abcd");
    expect(message).toContain(" — ");
  });

  it("handles non-error values", () => {
    expect(describeRestoreError("boom")).toBe("boom");
    expect(describeRestoreError(undefined)).toBe("unknown error");
  });
});
