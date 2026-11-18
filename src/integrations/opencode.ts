/**
 * OpenCode integration: writes the native v2 `providers.routstr` block.
 *
 * Two things are derived per model instead of curated:
 *   - `package`, because OpenCode selects the API shape (chat/completions,
 *     responses, messages) with a runtime package (see OPENCODE_PACKAGES), and
 *     the model family is the only signal for the two single-shape families;
 *   - `variants`, the reasoning-effort choices OpenCode offers in `/models` and
 *     cycles with ctrl+t, derived from the daemon's per-model allowlist (see
 *     deriveOpenCodeVariants).
 * Every other key in a model entry stays user-curated and survives a refresh.
 */
import { existsSync, mkdirSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import type { RoutstrdConfig } from "../utils/config";
import type { IntegrationConfig, RoutstrModel } from "./registry";
import { callDaemon, getDaemonBaseUrl } from "../utils/daemon-client";

const OPENCODE_SMALL_MODEL = "routstr/minimax-m2.5";

/**
 * API shape a model is served over: `chat` is `{root}/chat/completions`,
 * `responses` is `{root}/responses`, and `messages` is `{root}/messages` (the
 * Anthropic wire format).
 */
export type OpenCodeApiFormat = "chat" | "responses" | "messages";

/**
 * OpenCode picks the API shape with a runtime *package*, so a model's transport
 * is a model-level `package` override. Every package below lands on a route the
 * daemon serves (routstr-core canonicalizes exactly one optional `v1/`), and
 * OpenCode appends only its own endpoint to the configured base URL — even the
 * Anthropic-compatible runtime sends `/messages`, not `/v1/messages` — so one
 * root base URL covers all three:
 *   chat      -> {root}/chat/completions   (Authorization: Bearer)
 *   responses -> {root}/responses          (Authorization: Bearer)
 *   messages  -> {root}/messages           (x-api-key + anthropic-version)
 * Verified against opencode 2.0.26 by pointing each package at a local server
 * and logging the request path.
 */
export const OPENCODE_PACKAGES = {
  chat: "@opencode/ai/providers/openai-compatible",
  responses: "@opencode/ai/providers/openai-compatible/responses",
  messages: "@opencode/ai/providers/anthropic-compatible",
} as const satisfies Record<OpenCodeApiFormat, string>;

/**
 * The daemon publishes no transport metadata, so the model id is the only
 * signal — the same heuristic, over the same two families, as the pi
 * integration (see `buildPiModelEntry`). `null` means "no opinion", which lets
 * a user-curated value stand instead of forcing every other model to chat.
 */
export function deriveOpenCodeApiFormat(
  modelId: string,
): OpenCodeApiFormat | null {
  if (modelId.startsWith("gpt-")) return "responses";
  if (modelId.startsWith("claude")) return "messages";
  return null;
}

/**
 * One entry of the per-model `variants` list: the reasoning-effort choices
 * OpenCode shows under `/models` and cycles with ctrl+t. `settings` is merged
 * into the request body by the model's runtime package; see
 * deriveOpenCodeVariants for the package/setting mapping.
 */
export type OpenCodeVariant = {
  id: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
};

export type OpenCodeModelEntry = {
  /** Display name shown in the model picker. */
  name: string;
  /**
   * Runtime override selecting the API shape. Absent on chat/completions
   * models, which inherit the provider's package.
   */
  package?: string;
  /**
   * Reasoning-effort variants. Derived from the daemon's published allowlist
   * when there is one, otherwise whatever the user curated is left untouched.
   */
  variants?: OpenCodeVariant[];
  /** Anything else the user curated (limit, capabilities, ...). */
  [key: string]: unknown;
};

/**
 * The package a model should be served over, in precedence order:
 *   1. the family heuristic, which is authoritative for the two families that
 *      only work over one shape — a stale `package` on `claude-*` would
 *      silently pick the endpoint the daemon is not expecting;
 *   2. whatever the user already curated in opencode.json, for models outside
 *      those families;
 *   3. chat/completions, i.e. no override at all.
 */
export function resolveOpenCodePackage(
  modelId: string,
  previousPackage: unknown,
): string | undefined {
  const derived = deriveOpenCodeApiFormat(modelId);
  if (derived !== null) {
    return derived === "chat" ? undefined : OPENCODE_PACKAGES[derived];
  }

  if (typeof previousPackage === "string" && previousPackage.length > 0) {
    return previousPackage;
  }

  return undefined;
}

/**
 * The API format a resolved per-model `package` selects. `undefined` means the
 * provider default (the `openai-compatible` chat package), and an unrecognized
 * curated package is treated the same way: its request mapping is unknown, so
 * fall back to the shape the provider itself is configured for.
 */
export function openCodeApiFormatForPackage(
  pkg: string | undefined,
): OpenCodeApiFormat {
  if (pkg === OPENCODE_PACKAGES.responses) return "responses";
  if (pkg === OPENCODE_PACKAGES.messages) return "messages";
  return "chat";
}

/** Reasoning-effort ids in the daemon's documented order. */
const OPENCODE_EFFORT_ORDER: readonly string[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Efforts the daemon's Anthropic `/messages` route accepts under
 * `output_config.effort`. routstr-core rejects `none` and `minimal` there, so
 * they are skipped for the `messages` package instead of being emitted as
 * variants that always fail.
 */
const MESSAGES_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const effortRank = (effort: string): number => {
  const index = OPENCODE_EFFORT_ORDER.indexOf(effort);
  // Unknown efforts sort after the known ladder. They are not dropped for the
  // OpenAI-shaped packages: routstr-core clamps `reasoning_effort` itself, and
  // passing an effort the vocabulary has grown to is forward-compatible.
  return index === -1 ? OPENCODE_EFFORT_ORDER.length : index;
};

/**
 * Build OpenCode's per-model `variants` from the daemon's reasoning metadata,
 * the same way pi's deriveThinkingFields builds `thinkingLevelMap`.
 *
 * Why explicit variants rather than `capabilities.reasoning`: the models.dev v2
 * capability is not reliable for our custom provider. Measured against
 * opencode 2.0.28 with a local mock server:
 *   - `openai-compatible` (chat): always yields exactly low/medium/high. The
 *     `effort` allowlist is ignored, `toggle: true` does not add `none`, and an
 *     unknown effort string collapses the whole capability (even `low` goes).
 *   - `anthropic-compatible`: yields no variants at all.
 *   - `openai-compatible/responses`: yields no variants at all.
 * Explicit per-model `variants` are authoritative for every package and are the
 * only way to expose `max`/`xhigh`/`none`, so derive them from the allowlist.
 *
 * Package -> variant setting -> request body (verified in 2.0.28):
 *   openai-compatible            settings.reasoningEffort -> reasoning_effort
 *   openai-compatible/responses  settings.reasoningEffort -> reasoning.effort
 *   anthropic-compatible         settings.effort          -> output_config.effort
 *
 * Returns null when the daemon publishes no usable effort allowlist: those
 * models are not guessable, so the caller keeps whatever the user curated
 * (same contract as pi's deriveThinkingFields).
 */
export function deriveOpenCodeVariants(
  model: RoutstrModel,
  apiFormat: OpenCodeApiFormat,
): OpenCodeVariant[] | null {
  const reasoning = model.reasoning;
  if (!reasoning) return null;

  const supported = (reasoning.supported_efforts ?? [])
    .filter((effort): effort is string => typeof effort === "string")
    .map((effort) => effort.trim().toLowerCase())
    .filter(Boolean);

  const allowed = new Set(supported);
  // routstr-core strips `none` from mandatory models, so never offer it there.
  if (reasoning.mandatory === true) allowed.delete("none");

  // Sort by the documented effort ladder instead of the order the allowlist
  // happened to arrive in, so ctrl+t cycles variants predictably.
  const efforts = [...allowed].sort(
    (a, b) => effortRank(a) - effortRank(b) || a.localeCompare(b),
  );

  const variants: OpenCodeVariant[] = [];
  for (const effort of efforts) {
    if (apiFormat === "messages") {
      // The Anthropic route has no `none`/`minimal`; keep the legal subset and
      // let the caller preserve curated variants if nothing legal remains.
      if (!MESSAGES_EFFORTS.has(effort)) continue;
      variants.push({ id: effort, settings: { effort } });
    } else {
      // Both OpenAI-shaped packages take `reasoningEffort`; the runtime maps it
      // to `reasoning_effort` (chat) or `reasoning.effort` (responses).
      variants.push({ id: effort, settings: { reasoningEffort: effort } });
    }
  }

  return variants.length > 0 ? variants : null;
}

/**
 * Project one daemon model onto an opencode.json models entry.
 *
 * `previous` is the entry already in the file. OpenCode's model map is the only
 * place a user can curate fields the daemon does not publish (limits,
 * capabilities, ...), so those keys survive a refresh. Two keys are derived
 * every pass instead:
 *   - `package` is rewritten by `resolveOpenCodePackage`, so a stale pin cannot
 *     keep sending a model to the wrong endpoint unnoticed;
 *   - `variants` is replaced wholesale whenever the daemon publishes an
 *     allowlist, so a level the model no longer accepts cannot linger in the
 *     picker.
 *
 * Curated variants are a trade-off: opencode's model schema allows only
 * `id/settings/headers/body` on a variant (`additionalProperties: false`), so
 * there is no field to tag one as routstrd-managed and tell the two apart.
 * When the daemon publishes an allowlist the derived set is therefore
 * authoritative; a hand-curated variant survives only while that model has no
 * published allowlist (the same rule pi uses for `reasoning`/
 * `thinkingLevelMap`).
 */
export function buildOpenCodeModelEntry(
  model: RoutstrModel,
  previous?: OpenCodeModelEntry,
): OpenCodeModelEntry {
  const entry: OpenCodeModelEntry = {
    ...(previous ?? {}),
    name: model.name || model.id,
  };

  const pkg = resolveOpenCodePackage(model.id, previous?.package);
  if (pkg === undefined) delete entry.package;
  else entry.package = pkg;

  const variants = deriveOpenCodeVariants(
    model,
    openCodeApiFormatForPackage(pkg),
  );
  if (variants) {
    // Replace, never merge: a stale effort must not survive a refresh just
    // because the user never edited it.
    entry.variants = variants;
  }
  // Otherwise the `variants` spread from `previous` stays verbatim; the daemon
  // publishes no allowlist for this model, so the curated list is not guessable.

  return entry;
}

type OpenCodeProviderConfig = {
  npm?: string;
  name?: string;
  package?: string;
  options?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  models?: Record<string, OpenCodeModelEntry>;
};

type OpenCodeConfig = {
  provider?: Record<string, OpenCodeProviderConfig>;
  providers?: Record<string, OpenCodeProviderConfig>;
  small_model?: string;
};

export type OpenCodeIntegrationDeps = {
  callDaemon: typeof callDaemon;
  getDaemonBaseUrl: typeof getDaemonBaseUrl;
};

export async function installOpencodeIntegration(
  config: RoutstrdConfig,
  apiKey: string,
  integrationConfig: IntegrationConfig,
  // Injectable I/O so tests don't need mock.module, whose overrides leak
  // across test files for the rest of the run under bun's runner.
  deps: Partial<OpenCodeIntegrationDeps> = {},
): Promise<void> {
  const { name, configPath } = integrationConfig;
  const callDaemonFn = deps.callDaemon ?? callDaemon;
  const getDaemonBaseUrlFn = deps.getDaemonBaseUrl ?? getDaemonBaseUrl;

  console.log("\nInstalling routstr models in opencode.json...");
  console.log(`Using API key for ${name}`);

  const baseUrl = getDaemonBaseUrlFn(config);

  let opencodeConfig: OpenCodeConfig;

  try {
    if (existsSync(configPath)) {
      const content = await readFile(configPath, "utf-8");
      opencodeConfig = JSON.parse(content);
    } else {
      opencodeConfig = { providers: {} };
    }
  } catch (error) {
    console.error(`Failed to read or parse ${configPath}; leaving it unchanged:`, error);
    throw error;
  }

  if (!opencodeConfig.providers) {
    opencodeConfig.providers = {};
  }

  try {
    mkdirSync(dirname(configPath), { recursive: true });

    const data = await callDaemonFn("/models");
    if (data.error) throw new Error(`Failed to fetch models: ${data.error}`);
    const models = (data.output as { models: RoutstrModel[] } | undefined)?.models || [];

    if (models.length === 0) {
      throw new Error("No models found from routstr daemon; integration was not refreshed.");
    }

    // Rebuild the models map from the daemon, keeping the keys a user curated
    // by hand; `package` and `variants` are re-derived every pass (see
    // buildOpenCodeModelEntry).
    const previousModels = opencodeConfig.providers["routstr"]?.models ?? {};
    const modelsObj: Record<string, OpenCodeModelEntry> = {};
    for (const model of models) {
      modelsObj[model.id] = buildOpenCodeModelEntry(
        model,
        previousModels[model.id],
      );
    }

    opencodeConfig.providers["routstr"] = {
      name: "routstr",
      package: OPENCODE_PACKAGES.chat,
      settings: {
        baseURL: `${baseUrl}/`,
        apiKey,
        includeUsage: true,
      },
      models: modelsObj,
    };

    // The V1 `provider` shape cannot carry a per-model runtime package: mixing
    // the two formats inside one provider entry silently drops the model-level
    // `package` (verified against opencode 2.0.26), so the stale entry is
    // removed rather than left shadowing the native one.
    if (opencodeConfig.provider) {
      delete opencodeConfig.provider["routstr"];
      if (Object.keys(opencodeConfig.provider).length === 0) {
        delete opencodeConfig.provider;
      }
    }

    opencodeConfig.small_model = OPENCODE_SMALL_MODEL;

    await writeFile(configPath, JSON.stringify(opencodeConfig, null, 2));
    console.log(`Added "routstr" provider with ${models.length} models to opencode.json`);
  } catch (error) {
    console.error("Failed to install models in opencode.json:", error);
    throw error;
  }
}
