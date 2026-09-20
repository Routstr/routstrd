import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { RoutstrdConfig } from "../utils/config";
import type { IntegrationConfig, RoutstrModel } from "./registry";
import { callDaemon, getDaemonBaseUrl } from "../utils/daemon-client";

export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

export type PiModelEntry = {
  id: string;
  contextWindow?: number;
  name?: string;
  input?: string[];
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  compat?: Record<string, unknown>;
};

/** pi thinking levels, in pi's documented order. */
export const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * pi level -> the value sent to the provider. routstr-core publishes its
 * allowlist in this same vocabulary (`none`/`minimal`/`low`/`medium`/`high`/
 * `xhigh`/`max`), so the mapping is identity apart from `off`.
 */
const THINKING_LEVEL_VALUES: Record<PiThinkingLevel, string> = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Build pi's thinking fields from the daemon's per-model `reasoning` object.
 *
 * Every level is written explicitly: pi treats an omitted level as "use the
 * provider's default mapping" for standard levels (through `high`) and as
 * "unsupported" for `xhigh`/`max`, so a partial map would silently advertise
 * levels the model rejects. `null` hides the level in pi's UI.
 *
 * Returns null when the daemon publishes no effort allowlist (models whose
 * upstream only reports `mandatory`, or that report no reasoning at all).
 * Those are not guessable, so the caller keeps whatever the user curated.
 */
export function deriveThinkingFields(
  model: RoutstrModel,
): { reasoning: true; thinkingLevelMap: ThinkingLevelMap } | null {
  const reasoning = model.reasoning;
  if (!reasoning) return null;

  const supported = (reasoning.supported_efforts ?? [])
    .filter((effort): effort is string => typeof effort === "string")
    .map((effort) => effort.trim().toLowerCase())
    .filter(Boolean);
  if (supported.length === 0) return null;

  const allowed = new Set(supported);
  // routstr-core strips `none` from mandatory models, so never offer `off` there.
  if (reasoning.mandatory === true) allowed.delete("none");

  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const level of PI_THINKING_LEVELS) {
    const value = THINKING_LEVEL_VALUES[level];
    thinkingLevelMap[level] = allowed.has(value) ? value : null;
  }

  return { reasoning: true, thinkingLevelMap };
}

const isDeepSeekModel = (id: string): boolean => id.startsWith("deepseek");

/** Project one daemon model onto a pi config entry. */
export function buildPiModelEntry(
  model: RoutstrModel,
  previous?: PiModelEntry,
): PiModelEntry {
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

  const derived = deriveThinkingFields(model);
  if (derived) {
    entry.reasoning = derived.reasoning;
    entry.thinkingLevelMap = derived.thinkingLevelMap;
  } else {
    // No allowlist to derive from: keep the user's hand-curated fields rather
    // than guessing which levels the model accepts.
    if (previous?.reasoning !== undefined) entry.reasoning = previous.reasoning;
    if (previous?.thinkingLevelMap !== undefined) {
      entry.thinkingLevelMap = previous.thinkingLevelMap;
    }
  }

  // `compat` is never published by the daemon; it stays user-curated — except
  // for deepseek* models, where the role spelling below is authoritative.
  if (isDeepSeekModel(model.id)) {
    // DeepSeek-backed models reject the `developer` role (OpenAI's newer
    // spelling of `system`) on strict upstreams with a hard 400. Pi sends
    // `developer` for reasoning models on unrecognized providers because its
    // provider heuristics only see the local daemon URL and can't know
    // DeepSeek sits behind it — force the universally-accepted `system`
    // spelling for every deepseek* model, keeping any other user-set keys.
    entry.compat = { ...(previous?.compat ?? {}), supportsDeveloperRole: false };
  } else if (previous?.compat !== undefined) {
    entry.compat = previous.compat;
  }

  return entry;
}

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
    // models.json is always a faithful projection of the daemon's state.
    // Thinking fields are derived from the model's published reasoning allowlist;
    // when the daemon has none, the user's hand-curated values are preserved.
    // `compat` stays user-curated, except for the deepseek* pin applied below.
    const existingModels = new Map<string, PiModelEntry>(
      (piConfig.providers["routstr"]?.models ?? []).map((m) => [m.id, m]),
    );

    const providerModels: PiModelEntry[] = models.map((model) =>
      buildPiModelEntry(model, existingModels.get(model.id)),
    );

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
