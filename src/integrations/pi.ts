import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { RoutstrdConfig } from "../utils/config";
import type { IntegrationConfig, RoutstrModel } from "./registry";
import { callDaemon, getDaemonBaseUrl } from "../utils/daemon-client";

type PiModelEntry = {
  id: string;
  contextWindow?: number;
  name?: string;
  input?: string[];
  // Thinking/reasoning config is user-curated and preserved across refreshes.
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
};

type PiProviderConfig = {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: PiModelEntry[];
};

type PiConfig = {
  providers?: Record<string, PiProviderConfig>;
};

export async function installPiIntegration(
  config: RoutstrdConfig,
  apiKey: string,
  integrationConfig: IntegrationConfig,
): Promise<void> {
  const { name, configPath } = integrationConfig;

  console.log("\nInstalling routstr models in pi models.json...");
  console.log(`Using API key for ${name}`);

  const baseUrl = `${getDaemonBaseUrl(config)}/v1`;

  let piConfig: PiConfig = {};

  try {
    if (existsSync(configPath)) {
      const content = await readFile(configPath, "utf-8");
      piConfig = JSON.parse(content) as PiConfig;
    }
  } catch (error) {
    console.error(`Failed to read or parse ${configPath}; leaving it unchanged:`, error);
    return;
  }

  if (!piConfig.providers) {
    piConfig.providers = {};
  }

  try {
    // Ensure directory exists
    mkdirSync(dirname(configPath), { recursive: true });

    const data = await callDaemon("/models");
    const models = (data.output as { models: RoutstrModel[] } | undefined)?.models || [];

    if (models.length === 0) {
      console.log("No models found from routstr daemon.");
      return;
    }

    // Rebuild every model entry from scratch from the daemon, so the generated
    // models.json is always a faithful projection of the daemon's state. The only
    // exception is thinking/reasoning config (reasoning, thinkingLevelMap, compat),
    // which the daemon does not provide and the user curates by hand — preserve it.
    const existingModels = new Map<string, PiModelEntry>(
      (piConfig.providers["routstr"]?.models ?? []).map((m) => [m.id, m]),
    );

    const providerModels: PiModelEntry[] = models.map((model) => {
      const previous = existingModels.get(model.id);
      const entry: PiModelEntry = { id: model.id };

      if (model.context_length !== undefined && model.context_length > 0) {
        entry.contextWindow = model.context_length;
      }

      if (model.name) {
        entry.name = model.name;
      }

      // Map the daemon's input modalities to Pi's ["text", "image"] vocabulary.
      const mods = model.architecture?.input_modalities ?? [];
      const input: string[] = [];
      if (mods.includes("text")) input.push("text");
      if (mods.includes("image")) input.push("image");
      entry.input = input;

      // Preserve user-curated thinking fields from the previous entry.
      if (previous?.reasoning !== undefined) entry.reasoning = previous.reasoning;
      if (previous?.thinkingLevelMap !== undefined) entry.thinkingLevelMap = previous.thinkingLevelMap;
      if (previous?.compat !== undefined) entry.compat = previous.compat;

      return entry;
    });

    // Rebuild provider from scratch too; only write routstrd-managed fields.
    piConfig.providers["routstr"] = {
      baseUrl,
      api: "openai-completions",
      apiKey,
      models: providerModels,
    };

    await writeFile(configPath, JSON.stringify(piConfig, null, 2));
    console.log(`Added "routstr" provider with ${models.length} models to pi models.json`);
  } catch (error) {
    console.error("Failed to install models in pi models.json:", error);
  }
}
