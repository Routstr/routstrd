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

export type OpenCodeModelEntry = {
  /** Display name shown in the model picker. */
  name: string;
  /**
   * Runtime override selecting the API shape. Absent on chat/completions
   * models, which inherit the provider's package.
   */
  package?: string;
  /** Anything else the user curated (limit, capabilities, variants, ...). */
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
 * Project one daemon model onto an opencode.json models entry.
 *
 * `previous` is the entry already in the file. OpenCode's model map is the only
 * place a user can curate fields the daemon does not publish (limits,
 * capabilities, variants), so those keys survive a refresh. `package` is the
 * exception: it is rewritten by `resolveOpenCodePackage` every time, so a stale
 * pin cannot keep sending a model to the wrong endpoint unnoticed.
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
    // by hand; `package` is re-derived every pass (see
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
