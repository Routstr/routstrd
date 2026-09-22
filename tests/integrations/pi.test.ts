import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  IntegrationConfig,
  RoutstrModel,
} from "../../src/integrations/registry";
import {
  buildPiModelEntry,
  deriveThinkingFields,
  installPiIntegration,
  type PiIntegrationDeps,
  type PiModelEntry,
} from "../../src/integrations/pi";
import type { RoutstrdConfig } from "../../src/utils/config";

// Injected I/O instead of mock.module: bun's mock.module overrides leak
// across test files for the rest of the run and made tests/utils/
// daemon-client.test.ts fail non-deterministically depending on worker
// scheduling (see CI run 35723560562).
const MOCK_DEPS: Partial<PiIntegrationDeps> = {
  callDaemon: async () => ({
    output: {
      models: [
        {
          id: "deepseek-v4.1-flash",
          name: "DeepSeek V4.1 Flash",
          context_length: 1048576,
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "glm-5.3",
          name: "GLM 5.3",
          context_length: 262144,
          architecture: { input_modalities: ["text", "image"] },
        },
      ],
    },
  }),
  getDaemonBaseUrl: (config: RoutstrdConfig) =>
    `http://127.0.0.1:${config.port}`,
};

const CONFIG: RoutstrdConfig = { port: 8008 } as RoutstrdConfig;

function makeIntegration(configPath: string): IntegrationConfig {
  return { clientId: "pi-agent", name: "Pi Agent", configPath };
}

async function readProvider(configPath: string) {
  const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
    providers: Record<string, { models: Array<Record<string, unknown>> }>;
  };
  return parsed.providers["routstr"];
}

describe("installPiIntegration", () => {
  it("pins supportsDeveloperRole=false for deepseek* models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-models-"));
    const configPath = join(dir, "models.json");
    await installPiIntegration(CONFIG, "key", makeIntegration(configPath), MOCK_DEPS);

    const provider = await readProvider(configPath);
    const deepseek = provider.models.find((m) => m.id === "deepseek-v4.1-flash");
    expect(deepseek?.compat).toEqual({ supportsDeveloperRole: false });
  });

  it("leaves non-deepseek models without a compat block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-models-"));
    const configPath = join(dir, "models.json");
    await installPiIntegration(CONFIG, "key", makeIntegration(configPath), MOCK_DEPS);

    const provider = await readProvider(configPath);
    const glm = provider.models.find((m) => m.id === "glm-5.3");
    expect(glm?.compat).toBeUndefined();
  });

  it("preserves user compat keys on deepseek* models while pinning the role", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-models-"));
    const configPath = join(dir, "models.json");
    await installPiIntegration(CONFIG, "key", makeIntegration(configPath), MOCK_DEPS);

    // Simulate a user-curated refresh: seed reasoning/compat, run again.
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    const deepseek = parsed.providers["routstr"].models.find(
      (m) => m.id === "deepseek-v4.1-flash",
    );
    deepseek!.reasoning = true;
    deepseek!.compat = { supportsStrictMode: true };
    const { writeFileSync } = await import("fs");
    writeFileSync(configPath, JSON.stringify(parsed));

    await installPiIntegration(CONFIG, "key", makeIntegration(configPath), MOCK_DEPS);
    const provider = await readProvider(configPath);
    const updated = provider.models.find((m) => m.id === "deepseek-v4.1-flash");
    expect(updated?.compat).toEqual({
      supportsStrictMode: true,
      supportsDeveloperRole: false,
    });
    expect(updated?.reasoning).toBe(true);
  });

  it("preserves compat untouched for non-deepseek models across refreshes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-models-"));
    const configPath = join(dir, "models.json");
    await installPiIntegration(CONFIG, "key", makeIntegration(configPath), MOCK_DEPS);

    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    const glm = parsed.providers["routstr"].models.find((m) => m.id === "glm-5.3");
    glm!.compat = { supportsDeveloperRole: true };
    const { writeFileSync } = await import("fs");
    writeFileSync(configPath, JSON.stringify(parsed));

    await installPiIntegration(CONFIG, "key", makeIntegration(configPath), MOCK_DEPS);
    const provider = await readProvider(configPath);
    const updated = provider.models.find((m) => m.id === "glm-5.3");
    expect(updated?.compat).toEqual({ supportsDeveloperRole: true });
  });
});

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
      api: "openai-responses",
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

  it("pins api=openai-responses for gpt-* models, overriding any curated value", () => {
    const previous: PiModelEntry = { id: "gpt-5.6-sol", api: "openai-completions" };

    const entry = buildPiModelEntry(model({ id: "gpt-5.6-sol" }), previous);

    expect(entry.api).toBe("openai-responses");
  });

  it("preserves a user-curated api on non-gpt models and omits it otherwise", () => {
    const curated = buildPiModelEntry(
      model({ id: "glm-5.3" }),
      { id: "glm-5.3", api: "openai-responses" },
    );
    expect(curated.api).toBe("openai-responses");

    const plain = buildPiModelEntry(model({ id: "glm-5.3" }));
    expect("api" in plain).toBe(false);
  });
});
