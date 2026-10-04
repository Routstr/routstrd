import { describe, expect, it } from "bun:test";
import { collapseDuplicatedV1, ensureV1Prefix } from "./request-path";

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

describe("ensureV1Prefix", () => {
  it("versions a bare endpoint the node forwards", () => {
    // Tinfoil's router serves only /v1/..., and the node forwards the caller's
    // spelling: a bare path was answered with a paid upstream 404.
    expect(ensureV1Prefix("/chat/completions")).toBe("/v1/chat/completions");
    expect(ensureV1Prefix("/completions")).toBe("/v1/completions");
    expect(ensureV1Prefix("/responses")).toBe("/v1/responses");
    expect(ensureV1Prefix("/messages")).toBe("/v1/messages");
    expect(ensureV1Prefix("/messages/count_tokens")).toBe("/v1/messages/count_tokens");
    expect(ensureV1Prefix("/embeddings")).toBe("/v1/embeddings");
    expect(ensureV1Prefix("/systemone")).toBe("/v1/systemone");
  });

  it("leaves an already-versioned path alone, so it is idempotent", () => {
    for (const path of [
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/responses",
      "/v1/systemone",
      "/v1/messages/count_tokens",
    ]) {
      expect(ensureV1Prefix(path)).toBe(path);
      expect(ensureV1Prefix(ensureV1Prefix(path))).toBe(path);
    }
  });

  it("leaves the daemon's own routes and unknown paths untouched", () => {
    // The ingress matches these against its own handlers, and the node's
    // allowlist is exact — routstrd must not invent a path for either.
    for (const path of [
      "/health",
      "/models",
      "/models/glm-5.3/providers",
      "/wallet/receive",
      "/keys/api",
      "/clients",
      "/v1/models",
      "/v1",
      "/",
      "/openai/chat/completions",
      "/v1/v2/messages",
      "/chat/completions/extra",
    ]) {
      expect(ensureV1Prefix(path)).toBe(path);
    }
  });

  it("preserves a trailing slash and a query string", () => {
    expect(ensureV1Prefix("/chat/completions/")).toBe("/v1/chat/completions/");
    expect(ensureV1Prefix("/chat/completions?provider=ai.redsh1ft.com")).toBe(
      "/v1/chat/completions?provider=ai.redsh1ft.com",
    );
  });
});
