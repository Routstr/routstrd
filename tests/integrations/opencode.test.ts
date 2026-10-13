import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  IntegrationConfig,
  RoutstrModel,
} from "../../src/integrations/registry";
import {
  buildOpenCodeModelEntry,
  deriveOpenCodeApiFormat,
  installOpencodeIntegration,
  resolveOpenCodePackage,
  OPENCODE_PACKAGES,
  type OpenCodeIntegrationDeps,
  type OpenCodeModelEntry,
} from "../../src/integrations/opencode";
import type { RoutstrdConfig } from "../../src/utils/config";

// Injected I/O instead of mock.module: bun's mock.module overrides leak
// across test files for the rest of the run and made tests/utils/
// daemon-client.test.ts fail non-deterministically depending on worker
// scheduling (see CI run 35723560562).
const MOCK_DEPS: Partial<OpenCodeIntegrationDeps> = {
  callDaemon: async () => ({
    output: {
      models: [
        {
          id: "deepseek-v4.1-flash",
          name: "DeepSeek: DeepSeek V4.1 Flash",
          context_length: 1048576,
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "glm-5.3",
          name: "Z.ai: GLM 5.3",
          context_length: 262144,
          architecture: { input_modalities: ["text", "image"] },
        },
        {
          id: "claude-opus-5.5",
          name: "Anthropic: Claude Opus 5.5",
          context_length: 1000000,
          architecture: { input_modalities: ["text", "image"] },
        },
        {
          id: "gpt-6.1-sol",
          name: "OpenAI: GPT-6.1 Sol",
          context_length: 922000,
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
  return { clientId: "opencode", name: "OpenCode", configPath };
}

type RawConfig = {
  provider?: Record<string, Record<string, unknown>>;
  providers?: Record<string, Record<string, unknown>>;
  small_model?: string;
};

function readRaw(configPath: string): RawConfig {
  return JSON.parse(readFileSync(configPath, "utf-8")) as RawConfig;
}

function readProvider(configPath: string) {
  const parsed = readRaw(configPath);
  return parsed.providers?.["routstr"] as {
    name?: string;
    package?: string;
    settings?: Record<string, unknown>;
    models: Record<string, OpenCodeModelEntry>;
  };
}

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-config-")), "opencode.json");
}

describe("installOpencodeIntegration", () => {
  it("writes the native v2 provider pointing at the daemon root", async () => {
    const configPath = tempConfigPath();
    await installOpencodeIntegration(
      CONFIG,
      "sk-routstr",
      makeIntegration(configPath),
      MOCK_DEPS,
    );

    const provider = readProvider(configPath);
    // V2 keeps the runtime package, endpoint and request options apart. The
    // package decides the endpoint, so chat/completions is the provider default
    // and every other shape is a per-model override.
    expect(provider.package).toBe(OPENCODE_PACKAGES.chat);
    expect(provider.settings).toEqual({
      baseURL: "http://127.0.0.1:8008/",
      apiKey: "sk-routstr",
      includeUsage: true,
    });
    expect(readRaw(configPath).small_model).toBe("routstr/minimax-m2.5");
  });

  it("pins the messages package for claude* and responses for gpt-*", async () => {
    const configPath = tempConfigPath();
    await installOpencodeIntegration(
      CONFIG,
      "key",
      makeIntegration(configPath),
      MOCK_DEPS,
    );

    const { models } = readProvider(configPath);
    expect(models["claude-opus-5.5"]?.package).toBe(OPENCODE_PACKAGES.messages);
    expect(models["gpt-6.1-sol"]?.package).toBe(OPENCODE_PACKAGES.responses);
    // Everything else inherits the provider's package: no override at all.
    expect("package" in models["glm-5.3"]!).toBe(false);
    expect("package" in models["deepseek-v4.1-flash"]!).toBe(false);
    expect(models["glm-5.3"]?.name).toBe("Z.ai: GLM 5.3");
  });

  it("migrates away the V1 provider entry it wrote before", async () => {
    const configPath = tempConfigPath();
    const legacy = {
      provider: {
        routstr: {
          npm: "@ai-sdk/openai-compatible",
          name: "routstr",
          options: { baseURL: "http://127.0.0.1:8008/" },
          models: { "glm-5.3": { name: "GLM 5.3" } },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(legacy));

    await installOpencodeIntegration(
      CONFIG,
      "key",
      makeIntegration(configPath),
      MOCK_DEPS,
    );

    // Mixing the two shapes inside one provider entry silently drops the
    // per-model `package`, so the stale V1 block (and the container, once it is
    // empty) has to go rather than linger next to the native one.
    expect(readRaw(configPath).provider).toBeUndefined();
  });

  it("leaves other V1 providers in the file alone", async () => {
    const configPath = tempConfigPath();
    const legacy = {
      provider: {
        routstr: { npm: "@ai-sdk/openai-compatible", models: {} },
        acme: { npm: "@ai-sdk/openai-compatible", models: {} },
      },
    };
    writeFileSync(configPath, JSON.stringify(legacy));

    await installOpencodeIntegration(
      CONFIG,
      "key",
      makeIntegration(configPath),
      MOCK_DEPS,
    );

    expect(Object.keys(readRaw(configPath).provider ?? {})).toEqual(["acme"]);
  });

  it("preserves a hand-curated package on models outside the pinned families", async () => {
    const configPath = tempConfigPath();
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          routstr: {
            models: {
              "glm-5.3": {
                name: "GLM 5.3",
                package: OPENCODE_PACKAGES.responses,
              },
            },
          },
        },
      }),
    );

    await installOpencodeIntegration(
      CONFIG,
      "key",
      makeIntegration(configPath),
      MOCK_DEPS,
    );

    const { models } = readProvider(configPath);
    expect(models["glm-5.3"]?.package).toBe(OPENCODE_PACKAGES.responses);
  });

  it("keeps user-curated model keys and refreshes the name", async () => {
    const configPath = tempConfigPath();
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          routstr: {
            models: {
              "glm-5.3": {
                name: "stale name",
                limit: { context: 1000, output: 100 },
                capabilities: { tools: true },
              },
            },
          },
        },
      }),
    );

    await installOpencodeIntegration(
      CONFIG,
      "key",
      makeIntegration(configPath),
      MOCK_DEPS,
    );

    const { models } = readProvider(configPath);
    expect(models["glm-5.3"]).toEqual({
      name: "Z.ai: GLM 5.3",
      limit: { context: 1000, output: 100 },
      capabilities: { tools: true },
    });
  });

  it("replaces a stale hand-curated package on claude* models", async () => {
    const configPath = tempConfigPath();
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          routstr: {
            models: {
              "claude-opus-5.5": { name: "Claude", package: OPENCODE_PACKAGES.chat },
            },
          },
        },
      }),
    );

    await installOpencodeIntegration(
      CONFIG,
      "key",
      makeIntegration(configPath),
      MOCK_DEPS,
    );

    const { models } = readProvider(configPath);
    expect(models["claude-opus-5.5"]?.package).toBe(OPENCODE_PACKAGES.messages);
  });

  it("leaves the file unchanged when it cannot be parsed", async () => {
    const configPath = tempConfigPath();
    writeFileSync(configPath, "{ not json");

    await expect(installOpencodeIntegration(
      CONFIG,
      "key",
      makeIntegration(configPath),
      MOCK_DEPS,
    )).rejects.toThrow();

    expect(readFileSync(configPath, "utf-8")).toBe("{ not json");
  });

  it("rejects daemon error responses without changing the config", async () => {
    const configPath = tempConfigPath();
    const original = JSON.stringify({ providers: {} });
    writeFileSync(configPath, original);
    await expect(installOpencodeIntegration(CONFIG, "key", makeIntegration(configPath), {
      ...MOCK_DEPS,
      callDaemon: async () => ({ error: "daemon unavailable" }),
    })).rejects.toThrow("daemon unavailable");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("rejects config directory write failures", async () => {
    const parentFile = tempConfigPath();
    writeFileSync(parentFile, "not a directory");
    await expect(installOpencodeIntegration(CONFIG, "key", makeIntegration(join(parentFile, "models.json")), MOCK_DEPS))
      .rejects.toThrow();
    expect(readFileSync(parentFile, "utf8")).toBe("not a directory");
  });

  it("leaves the file unchanged when the daemon serves no models", async () => {
    const configPath = tempConfigPath();
    writeFileSync(configPath, JSON.stringify({ providers: {} }));

    await expect(installOpencodeIntegration(CONFIG, "key", makeIntegration(configPath), {
      ...MOCK_DEPS,
      callDaemon: async () => ({ output: { models: [] } }),
    })).rejects.toThrow("No models found");

    expect(readRaw(configPath).providers?.["routstr"]).toBeUndefined();
  });
});

const model = (over: Partial<RoutstrModel>): RoutstrModel => ({
  id: "test-model",
  ...over,
});

describe("deriveOpenCodeApiFormat", () => {
  it("maps the two single-shape families and has no opinion otherwise", () => {
    expect(deriveOpenCodeApiFormat("claude-opus-5.5")).toBe("messages");
    expect(deriveOpenCodeApiFormat("claude-sonnet-5")).toBe("messages");
    expect(deriveOpenCodeApiFormat("gpt-6.1-sol")).toBe("responses");
    expect(deriveOpenCodeApiFormat("deepseek-v4.1-flash")).toBeNull();
    expect(deriveOpenCodeApiFormat("glm-5.3")).toBeNull();
  });
});

describe("resolveOpenCodePackage", () => {
  it("falls back to the curated package, then to no override at all", () => {
    expect(
      resolveOpenCodePackage("glm-5.3", OPENCODE_PACKAGES.responses),
    ).toBe(OPENCODE_PACKAGES.responses);
    expect(resolveOpenCodePackage("glm-5.3", undefined)).toBeUndefined();
    expect(resolveOpenCodePackage("glm-5.3", "")).toBeUndefined();
    expect(resolveOpenCodePackage("glm-5.3", 42)).toBeUndefined();
  });

  it("keeps a stale curated package off the pinned families", () => {
    expect(
      resolveOpenCodePackage("claude-opus-5.5", OPENCODE_PACKAGES.chat),
    ).toBe(OPENCODE_PACKAGES.messages);
    expect(
      resolveOpenCodePackage("gpt-6.1-sol", OPENCODE_PACKAGES.messages),
    ).toBe(OPENCODE_PACKAGES.responses);
  });
});

describe("buildOpenCodeModelEntry", () => {
  it("falls back to the model id when the daemon publishes no name", () => {
    const entry = buildOpenCodeModelEntry(model({ id: "glm-5.3" }));

    expect(entry.name).toBe("glm-5.3");
    expect(entry.package).toBeUndefined();
  });
});
