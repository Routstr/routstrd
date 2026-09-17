import { describe, expect, it } from "bun:test";
import type { RoutstrModel } from "../../src/integrations/registry";
import {
  buildPiModelEntry,
  deriveThinkingFields,
  type PiModelEntry,
} from "../../src/integrations/pi";

const model = (over: Partial<RoutstrModel>): RoutstrModel => ({
  id: "test-model",
  ...over,
});

describe("deriveThinkingFields", () => {
  it("writes every level explicitly, mapping off to the provider's none", () => {
    const derived = deriveThinkingFields(
      model({
        reasoning: {
          mandatory: false,
          default_enabled: true,
          supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"],
          default_effort: "medium",
        },
      }),
    );

    expect(derived).toEqual({
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    });
  });

  it("hides off on mandatory models and nulls the gaps in the allowlist", () => {
    const derived = deriveThinkingFields(
      model({
        reasoning: {
          mandatory: true,
          default_enabled: true,
          supported_efforts: ["max", "high", "low"],
          default_effort: "max",
        },
      }),
    );

    expect(derived?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
  });

  it("never offers off on a mandatory model even if none is listed", () => {
    const derived = deriveThinkingFields(
      model({ reasoning: { mandatory: true, supported_efforts: ["high", "none"] } }),
    );

    expect(derived?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("keeps a sparse allowlist sparse", () => {
    const derived = deriveThinkingFields(
      model({ reasoning: { mandatory: false, supported_efforts: ["high", "minimal"] } }),
    );

    expect(derived?.thinkingLevelMap).toEqual({
      off: null,
      minimal: "minimal",
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("returns null when the upstream publishes no allowlist", () => {
    expect(deriveThinkingFields(model({ reasoning: { mandatory: false } }))).toBeNull();
    expect(deriveThinkingFields(model({ reasoning: null }))).toBeNull();
    expect(deriveThinkingFields(model({}))).toBeNull();
    expect(
      deriveThinkingFields(model({ reasoning: { supported_efforts: [] } })),
    ).toBeNull();
  });

  it("ignores unknown levels and normalizes case and padding", () => {
    const derived = deriveThinkingFields(
      model({ reasoning: { supported_efforts: [" HIGH ", "auto", "low"] } }),
    );

    expect(derived?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
  });
});

describe("buildPiModelEntry", () => {
  it("derives thinking fields alongside the rest of the entry", () => {
    const entry = buildPiModelEntry(
      model({
        id: "gpt-5.6-sol",
        name: "OpenAI: GPT-5.6 Sol",
        context_length: 1050000,
        architecture: { input_modalities: ["file", "image", "text"] },
        reasoning: { supported_efforts: ["max", "high", "none"] },
      }),
    );

    expect(entry).toEqual({
      id: "gpt-5.6-sol",
      name: "OpenAI: GPT-5.6 Sol",
      contextWindow: 1050000,
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
    });
  });

  it("overwrites a stale hand-written map when the daemon has an allowlist", () => {
    const previous: PiModelEntry = {
      id: "glm-5.3",
      reasoning: true,
      thinkingLevelMap: { off: "none", low: "low" },
      compat: { supportsReasoningEffort: true },
    };

    const entry = buildPiModelEntry(
      model({ id: "glm-5.3", reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"] } }),
      previous,
    );

    expect(entry.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
    // compat is never published by the daemon, so it survives.
    expect(entry.compat).toEqual({ supportsReasoningEffort: true });
  });

  it("preserves hand-curated thinking fields when the daemon cannot decide", () => {
    const previous: PiModelEntry = {
      id: "minimax-m3",
      reasoning: true,
      thinkingLevelMap: { off: null },
      compat: { supportsReasoningEffort: false },
    };

    const entry = buildPiModelEntry(
      model({ id: "minimax-m3", reasoning: { mandatory: false } }),
      previous,
    );

    expect(entry.reasoning).toBe(true);
    expect(entry.thinkingLevelMap).toEqual({ off: null });
    expect(entry.compat).toEqual({ supportsReasoningEffort: false });
  });

  it("omits thinking fields entirely when neither side has any", () => {
    const entry = buildPiModelEntry(model({ id: "gemma-4-uncensored" }));

    expect(entry).toEqual({ id: "gemma-4-uncensored", input: [] });
    expect("reasoning" in entry).toBe(false);
    expect("thinkingLevelMap" in entry).toBe(false);
  });
});
