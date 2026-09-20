import { describe, expect, it } from "bun:test";
import {
  OPENAI_JSON_BODY_PATH_SUFFIXES,
  applyDefaultOutputTokenLimit,
  isOpenAiJsonBodyPath,
} from "./request-body";

const MAX_TOKENS = 64000;

describe("isOpenAiJsonBodyPath", () => {
  it("accepts OpenAI-compatible endpoints, with or without a prefix/query/slash", () => {
    for (const suffix of OPENAI_JSON_BODY_PATH_SUFFIXES) {
      expect(isOpenAiJsonBodyPath(`/v1${suffix}`)).toBe(true);
      expect(isOpenAiJsonBodyPath(`/proxy/v1${suffix}?trace=1`)).toBe(true);
      expect(isOpenAiJsonBodyPath(`/v1${suffix}/`)).toBe(true);
    }
  });

  it("rejects endpoints that do not define the OpenAI request vocabulary", () => {
    for (const path of ["/v1/systemone", "/v1/embeddings", "/v1/audio/speech", "/v1/messages"]) {
      expect(isOpenAiJsonBodyPath(path)).toBe(false);
    }
  });
});

describe("applyDefaultOutputTokenLimit", () => {
  it("injects max_tokens on chat/completions", () => {
    const body: Record<string, unknown> = { model: "glm-5.3-flash", messages: [] };
    expect(applyDefaultOutputTokenLimit("/v1/chat/completions", body, MAX_TOKENS)).toBe(true);
    expect(body.max_tokens).toBe(MAX_TOKENS);
  });

  it("injects max_output_tokens on /responses", () => {
    const body: Record<string, unknown> = { model: "gpt-5.4", input: "hi" };
    expect(applyDefaultOutputTokenLimit("/v1/responses", body, MAX_TOKENS)).toBe(true);
    expect(body.max_output_tokens).toBe(MAX_TOKENS);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("keeps a client-supplied limit", () => {
    const body: Record<string, unknown> = { messages: [], max_tokens: 5 };
    expect(applyDefaultOutputTokenLimit("/v1/chat/completions", body, MAX_TOKENS)).toBe(false);
    expect(body.max_tokens).toBe(5);
  });

  it("leaves /v1/systemone untouched — the upstream rejects unknown fields", () => {
    const body: Record<string, unknown> = {
      state: "Help! My payouts have been failing for 3 days.",
      model: "jev-latest",
      questions: { is_urgent: { type: "noul", instructions: "Does this convey urgency?" } },
    };
    const before = structuredClone(body);
    expect(applyDefaultOutputTokenLimit("/v1/systemone", body, MAX_TOKENS)).toBe(false);
    expect(body).toEqual(before);
  });

  it("is a no-op when injection is disabled", () => {
    const body: Record<string, unknown> = { messages: [] };
    expect(applyDefaultOutputTokenLimit("/v1/chat/completions", body, 0)).toBe(false);
    expect(body).not.toHaveProperty("max_tokens");
  });
});
