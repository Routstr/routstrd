import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { parseDocument } from "yaml";
import type { RoutstrdConfig } from "../utils/config";
import type { IntegrationConfig, RoutstrModel } from "./registry";
import { callDaemon, getDaemonBaseUrl } from "../utils/daemon-client";

interface HermesRoutstrConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

interface HermesCustomProvider {
  name?: string;
  [key: string]: unknown;
}

export function mergeHermesConfig(
  content: string,
  routstr: HermesRoutstrConfig,
): string {
  const document = parseDocument(content || "{}", { prettyErrors: true });
  if (document.errors.length > 0) {
    throw document.errors[0];
  }

  const urlDisplay = routstr.baseUrl
    .replace(/\/v1$/, "")
    .replace(/^https?:\/\//, "");
  const provider = {
    name: `Routstr (${urlDisplay})`,
    base_url: routstr.baseUrl,
    api_key: routstr.apiKey,
    model: routstr.defaultModel,
  };

  const isNewConfig = content.trim() === "";
  if (isNewConfig) {
    document.set("model", {
      default: routstr.defaultModel,
      provider: "custom",
      base_url: routstr.baseUrl,
      api_key: routstr.apiKey,
    });
  }

  const existingConfig = document.toJS() as {
    custom_providers?: HermesCustomProvider[];
  };
  const existingProviders = existingConfig.custom_providers;
  const providers = Array.isArray(existingProviders) ? existingProviders : [];
  if (providers.some((item) => item.name?.startsWith("Routstr ("))) {
    return content;
  }
  providers.push(provider);
  document.set("custom_providers", providers);

  return document.toString();
}

export async function installHermesIntegration(
  config: RoutstrdConfig,
  apiKey: string,
  integrationConfig: IntegrationConfig,
): Promise<void> {
  const { name, configPath } = integrationConfig;

  console.log(`\nInstalling routstr configuration in ${configPath}...`);
  console.log(`Using API key for ${name}`);

  const baseUrl = getDaemonBaseUrl(config);
  const baseUrlV1 = `${baseUrl}/v1`;

  let defaultModel = "minimax-m2.7";

  try {
    const data = await callDaemon("/models");
    const models = (data.output as { models: RoutstrModel[] } | undefined)?.models || [];

    if (models.length >= 3) {
      defaultModel = models[2]!.id;
      console.log(`Using 3rd available model for new Hermes configurations: ${defaultModel}`);
    } else if (models.length > 0) {
      defaultModel = models[0]!.id;
      console.log(`Only ${models.length} models available, using ${defaultModel} for new Hermes configurations.`);
    } else {
      console.log("No models available from routstr daemon, using fallback default.");
    }
  } catch (error) {
    console.error("Failed to fetch models for Hermes integration:", error);
    console.log("Using fallback default model.");
  }

  let content = "";
  try {
    if (existsSync(configPath)) {
      content = await readFile(configPath, "utf-8");
    }
  } catch (error) {
    console.error(`Failed to read ${configPath}; leaving it unchanged:`, error);
    return;
  }

  let newContent: string;
  try {
    newContent = mergeHermesConfig(content, {
      baseUrl: baseUrlV1,
      apiKey,
      defaultModel,
    });
  } catch (error) {
    console.error(`Failed to parse ${configPath} as YAML; leaving it unchanged:`, error);
    return;
  }

  try {
    if (newContent === content) {
      console.log(`${configPath} already contains current routstr settings.`);
      return;
    }

    mkdirSync(dirname(configPath), { recursive: true });
    await writeFile(configPath, newContent);
    console.log(`Successfully updated ${configPath} with routstr settings.`);
  } catch (error) {
    console.error(`Failed to write to ${configPath}:`, error);
  }
}
