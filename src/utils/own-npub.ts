import type { RoutstrdConfig } from "./config";
import { getUserNpub } from "./daemon-client";

/**
 * Render the operator's own npub for commands that cannot reach a node.
 *
 * Several commands dead-end when no remote node is configured (`npubs`, a bare
 * `routstrd remote`). The identity in `config.json` is still readable there,
 * and showing it turns the dead end into a next step: the operator can hand
 * that npub to an admin instead of hunting for a key.
 *
 * Returns null when no identity is configured (a fresh install with no `nsec`)
 * or when the stored `nsec` does not parse, so callers omit the line rather
 * than print an empty one.
 */
export function formatOwnNpub(config: RoutstrdConfig): string | null {
  const npub = getUserNpub(config);
  return npub ? `Your npub: ${npub}` : null;
}
