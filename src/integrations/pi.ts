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
  api?: string;
  baseUrl?: string;
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
const isGptModel = (id: string): boolean => id.startsWith("gpt-");
/**
 * Anthropic-served models (claude-opus-5.5, claude-sonnet-5, claude-fable-5.1,
 * ...). routstr nodes proxy the Anthropic-native `messages` route, so pi's
 * Anthropic transport can talk to the node's own endpoint instead of the
 * OpenAI-shaped translation.
 */
const isClaudeModel = (id: string): boolean => id.startsWith("claude");

export type PiModelEntryOptions = {
  /**
   * The daemon ROOT, without `/v1`. Assigned as the per-model `baseUrl` for
   * models served over the Anthropic transport; see `buildPiModelEntry`.
   */
  anthropicBaseUrl?: string;
};

/** Project one daemon model onto a pi config entry. */
export function buildPiModelEntry(
  model: RoutstrModel,
  previous?: PiModelEntry,
  options: PiModelEntryOptions = {},
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

  // Per-model transport pins. `api` is per-model while the provider `baseUrl`
  // is shared, and the transports disagree about what a base URL means: the
  // OpenAI SDKs append only their endpoint (`/chat/completions`, `/responses`)
  // and expect the version segment to already be in the base URL, while
  // Anthropic SDKs append `/v1/messages` themselves. The provider base URL is
  // therefore the versioned one (`{root}/v1`, see installPiIntegration), which
  // is what the OpenAI transports need:
  //   gpt-*   -> {root}/v1/responses        -> `responses`
  //   other   -> {root}/v1/chat/completions -> `chat/completions`
  // Pins override a curated value: a stale `anthropic-messages` left on a
  // non-claude model picks an endpoint the daemon is not expecting, and the
  // user cannot see from models.json which family needs which transport.
  if (isGptModel(model.id)) {
    entry.api = "openai-responses";
  } else if (isClaudeModel(model.id)) {
    entry.api = "anthropic-messages";
  } else if (previous?.api !== undefined) {
    entry.api = previous.api;
  }

  // Anthropic-served models need the ROOT base URL, because their SDK appends
  // the version segment itself: `{root}` + `/v1/messages` reaches the daemon's
  // `messages` route, while the inherited `{root}/v1` would double the prefix
  // to `/v1/v1/messages` — which routstr-core rejects (it canonicalizes exactly
  // one optional `v1/`) with a 404 from every provider in the pool.
  //
  // Keyed on the transport actually in effect rather than on the model name, so
  // a user-curated `api: "anthropic-messages"` on a non-claude model is served
  // correctly too. Everything else inherits the provider base URL.
  const effectiveApi = entry.api ?? "openai-completions";
  if (options.anthropicBaseUrl && effectiveApi === "anthropic-messages") {
    entry.baseUrl = options.anthropicBaseUrl;
  }

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

export type PiIntegrationDeps = {
  callDaemon: typeof callDaemon;
  getDaemonBaseUrl: typeof getDaemonBaseUrl;
};

export async function installPiIntegration(
  config: RoutstrdConfig,
  apiKey: string,
  integrationConfig: IntegrationConfig,
  // Injectable I/O so tests don't need mock.module, whose overrides leak
  // across test files for the rest of the run under bun's runner.
  deps: Partial<PiIntegrationDeps> = {},
): Promise<void> {
  const { name, configPath } = integrationConfig;
  const callDaemonFn = deps.callDaemon ?? callDaemon;
  const getDaemonBaseUrlFn = deps.getDaemonBaseUrl ?? getDaemonBaseUrl;

  console.log("\nInstalling routstr models in pi models.json...");
  console.log(`Using API key for ${name}`);

  // The provider base URL is the versioned one, because that is what the
  // OpenAI-shaped transports need: their SDKs append only their endpoint
  // (`/chat/completions`, `/responses`) and expect the version segment to come
  // from the base URL. Both the default `openai-completions` transport and the
  // `openai-responses` one therefore land on an allowed route:
  //   other -> {root}/v1/chat/completions
  //   gpt-* -> {root}/v1/responses
  // Anthropic-served models override this per model with the ROOT, since the
  // Anthropic SDK appends `/v1/messages` itself (see buildPiModelEntry); a
  // shared `{root}/v1` would double the prefix for them. getDaemonBaseUrl()
  // strips any trailing slash, so no path can be double-slashed either.
  const rootBaseUrl = getDaemonBaseUrlFn(config);
  const baseUrl = `${rootBaseUrl}/v1`;

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

    const data = await callDaemonFn("/models");
    const models = (data.output as { models: RoutstrModel[] } | undefined)?.models || [];

    if (models.length === 0) {
      console.log("No models found from routstr daemon.");
      return;
    }

    // Rebuild every model entry from scratch from the daemon, so the generated
    // models.json is always a faithful projection of the daemon's state.
    // Thinking fields are derived from the model's published reasoning allowlist;
    // when the daemon has none, the user's hand-curated values are preserved.
    // `compat` stays user-curated, except for the deepseek* pin applied below;
    // `api` is pinned per family (see buildPiModelEntry), since the family
    // decides which transport — and so which endpoint and base URL — the model
    // is served by.
    const existingModels = new Map<string, PiModelEntry>(
      (piConfig.providers["routstr"]?.models ?? []).map((m) => [m.id, m]),
    );

    const providerModels: PiModelEntry[] = models.map((model) =>
      buildPiModelEntry(model, existingModels.get(model.id), {
        anthropicBaseUrl: rootBaseUrl,
      }),
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
