import { describe, expect, it } from "bun:test";
import { collapseDuplicatedV1 } from "./request-path";

describe("collapseDuplicatedV1", () => {
  it("collapses the doubled prefix an Anthropic-style client produces", () => {
    // base URL ends in /v1 and the Anthropic SDK appends /v1/messages itself
    expect(collapseDuplicatedV1("/v1/v1/messages")).toBe("/v1/messages");
    expect(collapseDuplicatedV1("/v1/v1/messages/count_tokens")).toBe(
      "/v1/messages/count_tokens",
    );
    expect(collapseDuplicatedV1("/v1/v1/chat/completions")).toBe("/v1/chat/completions");
  });

  it("collapses every repetition, including a bare or trailing-slash path", () => {
    expect(collapseDuplicatedV1("/v1/v1/v1/messages")).toBe("/v1/messages");
    expect(collapseDuplicatedV1("/v1/v1")).toBe("/v1");
    expect(collapseDuplicatedV1("/v1/v1/")).toBe("/v1/");
  });

  it("leaves canonical and unprefixed paths untouched", () => {
    for (const path of [
      "/v1/messages",
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/systemone",
      "/chat/completions",
      "/responses",
      "/v1/models",
      "/v1/v1x/messages",
      "/v1/v2/v1/messages",
      "/health",
      "/",
    ]) {
      expect(collapseDuplicatedV1(path)).toBe(path);
    }
  });

  it("is idempotent", () => {
    const once = collapseDuplicatedV1("/v1/v1/v1/messages");
    expect(collapseDuplicatedV1(once)).toBe(once);
  });
});
