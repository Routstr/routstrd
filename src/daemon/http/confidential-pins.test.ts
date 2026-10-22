import { describe, expect, test } from "bun:test";
import { announcedNodePubkeys } from "./index";

const URL_ = "https://node.example.com/";

function deps(nodes: string[], labels: Record<string, string>, enabled = ["lgtm"]) {
  return {
    modelManager: {
      getProviderReviewIndex: async () => ({
        providerNodes: new Map([[URL_, new Set(nodes)]]),
        latestLabelByNode: new Map(Object.entries(labels)),
      }),
      getEnabledReviewLabels: () => enabled,
    },
  };
}

describe("confidential pins from announcements", () => {
  test("a key that only announced the URL is not a pin", async () => {
    // The node's reviewed key and an unrelated key announcing the same URL.
    const d = deps(["node", "squatter"], { node: "lgtm" });
    expect(await announcedNodePubkeys(d, "https://node.example.com")).toEqual(["node"]);
  });

  test("a key whose latest review is not enabled is not a pin", async () => {
    const d = deps(["node", "other"], { node: "scam", other: "sandbox" });
    expect(await announcedNodePubkeys(d, URL_)).toEqual([]);
    // A label the user enabled counts.
    const opted = deps(["other"], { other: "sandbox" }, ["lgtm", "sandbox"]);
    expect(await announcedNodePubkeys(opted, URL_)).toEqual(["other"]);
  });

  test("an unknown URL has no pins", async () => {
    expect(await announcedNodePubkeys(deps(["node"], { node: "lgtm" }), "https://other.example")).toEqual([]);
  });
});
