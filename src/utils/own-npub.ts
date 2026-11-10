import { existsSync, readFileSync } from "fs";
import { CONFIG_FILE, DEFAULT_CONFIG, type RoutstrdConfig } from "./config";
import { getUserNpub } from "./daemon-client";

/**
 * Render the operator's own npub for commands that cannot reach a node.
 *
 * Several commands dead-end when no remote node is configured (`npubs`, a bare
 * `routstrd remote`, `--version`). The identity in `config.json` is still
 * readable there, and showing it turns the dead end into a next step: the
 * operator can hand that npub to an admin instead of hunting for a key.
 *
 * Returns null when no identity is configured (a fresh install with no `nsec`)
 * or when the stored `nsec` does not parse, so callers omit the line rather
 * than print an empty one.
 */
export function formatOwnNpub(config: RoutstrdConfig): string | null {
  const npub = getUserNpub(config);
  return npub ? `Your npub: ${npub}` : null;
}

/**
 * Same as {@link formatOwnNpub}, but reads the config file itself.
 *
 * Commander runs option handlers (notably `--version`) to completion and then
 * calls `process.exit`, so an `await loadConfig()` there would never resume.
 * This variant is synchronous and deliberately side-effect free: it does not
 * create or chmod the config file the way the daemon config store does, so
 * `routstrd --version` cannot rewrite an operator's config permissions.
 *
 * `configFile` is injectable so tests can point at a temp path; production
 * callers use the resolved `CONFIG_FILE`.
 */
export function formatOwnNpubSync(configFile: string = CONFIG_FILE): string | null {
  try {
    if (!existsSync(configFile)) return null;
    const stored = JSON.parse(readFileSync(configFile, "utf-8"));
    return formatOwnNpub({ ...DEFAULT_CONFIG, ...stored });
  } catch {
    // An unreadable or malformed config must not break a version print.
    return null;
  }
}
