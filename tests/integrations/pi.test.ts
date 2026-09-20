import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { IntegrationConfig } from "../../src/integrations/registry";
import { installPiIntegration } from "../../src/integrations/pi";
import type { RoutstrdConfig } from "../../src/utils/config";

// Install the mock before importing modules that pull it in transitively.
mock.module("../../src/utils/daemon-client", () => ({
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
}));

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
    await installPiIntegration(CONFIG, "key", makeIntegration(configPath));

    const provider = await readProvider(configPath);
    const deepseek = provider.models.find((m) => m.id === "deepseek-v4.1-flash");
    expect(deepseek?.compat).toEqual({ supportsDeveloperRole: false });
  });

  it("leaves non-deepseek models without a compat block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-models-"));
    const configPath = join(dir, "models.json");
    await installPiIntegration(CONFIG, "key", makeIntegration(configPath));

    const provider = await readProvider(configPath);
    const glm = provider.models.find((m) => m.id === "glm-5.3");
    expect(glm?.compat).toBeUndefined();
  });

  it("preserves user compat keys on deepseek* models while pinning the role", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-models-"));
    const configPath = join(dir, "models.json");
    await installPiIntegration(CONFIG, "key", makeIntegration(configPath));

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

    await installPiIntegration(CONFIG, "key", makeIntegration(configPath));
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
    await installPiIntegration(CONFIG, "key", makeIntegration(configPath));

    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    const glm = parsed.providers["routstr"].models.find((m) => m.id === "glm-5.3");
    glm!.compat = { supportsDeveloperRole: true };
    const { writeFileSync } = await import("fs");
    writeFileSync(configPath, JSON.stringify(parsed));

    await installPiIntegration(CONFIG, "key", makeIntegration(configPath));
    const provider = await readProvider(configPath);
    const updated = provider.models.find((m) => m.id === "glm-5.3");
    expect(updated?.compat).toEqual({ supportsDeveloperRole: true });
  });
});
