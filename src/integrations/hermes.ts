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

/** Hermes references a custom provider as `custom:<slug>`, where the slug is
 *  the provider name lowercased with runs of whitespace collapsed to hyphens
 *  (e.g. `Routstr (routstr.ft.hn)` -> `custom:routstr-(routstr.ft.hn)`). */
function hermesProviderRef(name: string): string {
  return `custom:${name.toLowerCase().replace(/\s+/g, "-")}`;
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
  const providerName = `Routstr (${urlDisplay})`;
  const provider = {
    name: providerName,
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

  // Replace an existing Routstr custom provider in place so that re-running
  // `clients add --hermes` after changing the daemon URL updates base_url /
  // api_key / model instead of silently keeping the stale entry. We only touch
  // the first matching entry; any other providers are left as-is.
  const existingConfig = document.toJS() as {
    custom_providers?: HermesCustomProvider[];
  };
  const existingProviders = existingConfig.custom_providers;
  const providers = Array.isArray(existingProviders)
    ? existingProviders.slice()
    : [];
  const routstrIndex = providers.findIndex(
    (item) => typeof item?.name === "string" && item.name.startsWith("Routstr ("),
  );
  let previousName: string | undefined;
  if (routstrIndex >= 0) {
    previousName = providers[routstrIndex]!.name;
    providers[routstrIndex] = { ...providers[routstrIndex], ...provider };
  } else {
    providers.push(provider);
  }
  document.set("custom_providers", providers);

  // If we renamed the Routstr provider, keep `model.provider` pointing at it so
  // Hermes doesn't end up referencing a provider that no longer exists. We only
  // adjust configs whose default model already routes through a Routstr custom
  // provider, leaving any other selection untouched.
  if (
    !isNewConfig &&
    previousName &&
    previousName !== providerName &&
    document.hasIn(["model", "provider"])
  ) {
    const currentRef = document.getIn(["model", "provider"]);
    if (
      typeof currentRef === "string" &&
      currentRef === hermesProviderRef(previousName)
    ) {
      document.setIn(["model", "provider"], hermesProviderRef(providerName));
    }
  }

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
