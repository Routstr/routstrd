import { describe, expect, it } from "bun:test";
import type { CoreProof } from "@cashu/coco-core";
import {
  chunk,
  groupProofsByMint,
  pairProofStates,
  partitionCheckedProofs,
  totalAmount,
} from "./proof-check";

function proof(overrides: Record<string, unknown> = {}): CoreProof {
  return {
    mintUrl: "https://mint.example",
    id: "00aabb",
    amount: 1,
    secret: "s1",
    C: "c1",
    state: "ready",
    ...overrides,
  } as unknown as CoreProof;
}

describe("groupProofsByMint", () => {
  it("groups proofs under their mint, preserving first-seen mint order", () => {
    const groups = groupProofsByMint([
      proof({ mintUrl: "https://b.example", secret: "b1" }),
      proof({ mintUrl: "https://a.example", secret: "a1" }),
      proof({ mintUrl: "https://b.example", secret: "b2" }),
    ]);

    expect(groups.map((group) => group.mintUrl)).toEqual([
      "https://b.example",
      "https://a.example",
    ]);
    expect(groups[0]!.proofs.map((p) => p.secret)).toEqual(["b1", "b2"]);
    expect(groups[1]!.proofs.map((p) => p.secret)).toEqual(["a1"]);
  });

  it("drops proofs with no mint URL, since no mint can be asked about them", () => {
    const groups = groupProofsByMint([
      proof({ mintUrl: "", secret: "orphan" }),
      proof({ mintUrl: "https://a.example", secret: "a1" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.mintUrl).toBe("https://a.example");
  });

  it("returns nothing for no proofs", () => {
    expect(groupProofsByMint([])).toEqual([]);
  });
});

describe("chunk", () => {
  it("splits into batches that keep order and cover every item", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no batches for no items", () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it("rejects a non-positive or fractional batch size", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], -1)).toThrow(RangeError);
    expect(() => chunk([1], 1.5)).toThrow(RangeError);
  });
});

describe("pairProofStates", () => {
  it("pairs each proof with the state reported for it", () => {
    const proofs = [proof({ secret: "s1" }), proof({ secret: "s2" })];
    const paired = pairProofStates(proofs, [{ state: "SPENT" }, { state: "UNSPENT" }]);

    expect(paired).not.toBeNull();
    expect(paired!.map((entry) => [entry.proof.secret, entry.state])).toEqual([
      ["s1", "SPENT"],
      ["s2", "UNSPENT"],
    ]);
  });

  it("refuses a short response, which would shift states onto the wrong proofs", () => {
    expect(pairProofStates([proof(), proof()], [{ state: "SPENT" }])).toBeNull();
  });

  it("refuses a long response", () => {
    expect(
      pairProofStates([proof()], [{ state: "SPENT" }, { state: "UNSPENT" }]),
    ).toBeNull();
  });

  it("refuses a missing or non-string state rather than guessing", () => {
    expect(pairProofStates([proof()], [{}])).toBeNull();
    expect(pairProofStates([proof()], [undefined])).toBeNull();
  });

  it("accepts an empty check", () => {
    expect(pairProofStates([], [])).toEqual([]);
  });
});

describe("partitionCheckedProofs", () => {
  it("separates spent, unspent and unresolved, leaving PENDING unresolved", () => {
    const { spent, unspent, unresolved } = partitionCheckedProofs([
      { proof: proof({ secret: "s1" }), state: "SPENT" },
      { proof: proof({ secret: "s2" }), state: "UNSPENT" },
      { proof: proof({ secret: "s3" }), state: "PENDING" },
      { proof: proof({ secret: "s4" }), state: "SOMETHING_NEW" },
    ]);

    expect(spent.map((e) => e.proof.secret)).toEqual(["s1"]);
    expect(unspent.map((e) => e.proof.secret)).toEqual(["s2"]);
    expect(unresolved.map((e) => e.proof.secret)).toEqual(["s3", "s4"]);
  });
});

describe("totalAmount", () => {
  it("sums proof amounts", () => {
    expect(totalAmount([proof({ amount: 2 }), proof({ amount: 30 })])).toBe(32);
  });

  it("is zero for no proofs", () => {
    expect(totalAmount([])).toBe(0);
  });
});
