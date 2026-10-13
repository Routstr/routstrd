import { randomBytes } from "crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import { CONFIG_DIR } from "./config";
import { compareVersions } from "./update-checker";

/** Where the daemon caches the result of its last update check. */
export const UPDATE_STATE_FILE = `${CONFIG_DIR}/update-state.json`;

/**
 * How long a cached check is trusted. The daemon refreshes every 6 hours, so a
 * day tolerates several missed passes (host asleep, daemon stopped) before the
 * CLI/TUI treat the state as unknown instead of nagging with stale data.
 */
export const MAX_UPDATE_STATE_AGE_MS = 24 * 60 * 60 * 1000;

/** Snapshot of the last routstrd update check, written by the daemon. */
export interface UpdateState {
  /** routstrd version that produced this state. */
  current: string;
  /** Latest version seen at `checkedAt`, or null when unknown. */
  latest: string | null;
  /** Whether `latest` is newer than `current`. */
  hasUpdate: boolean;
  /** ISO-8601 timestamp of the check. */
  checkedAt: string;
}

function isValidState(value: unknown): value is UpdateState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.current === "string" &&
    (state.latest === null || typeof state.latest === "string") &&
    typeof state.hasUpdate === "boolean" &&
    typeof state.checkedAt === "string"
  );
}

/** Read the cached update state, or null when it is missing or corrupt. */
export function readUpdateState(
  path: string = UPDATE_STATE_FILE,
): UpdateState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isValidState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist update state atomically (temp file + rename) with 0600 permissions,
 * matching the config/wallet handling — the file is not secret, but nothing
 * under the config dir should inherit the umask default.
 */
export function writeUpdateState(
  state: UpdateState,
  path: string = UPDATE_STATE_FILE,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
}

/** Whether a cached check is recent enough to trust. */
export function isUpdateStateFresh(
  state: UpdateState,
  maxAgeMs: number = MAX_UPDATE_STATE_AGE_MS,
  now: number = Date.now(),
): boolean {
  const checkedAt = Date.parse(state.checkedAt);
  return Number.isFinite(checkedAt) && now >= checkedAt && now - checkedAt <= maxAgeMs;
}

/** Trust only a recent update detected by this running version. */
export function isUpdateStateApplicable(
  state: UpdateState,
  current: string,
  now: number = Date.now(),
): boolean {
  return isUpdateStateFresh(state, undefined, now) &&
    state.current === current && state.hasUpdate && !!state.latest &&
    (compareVersions(state.latest, current) ?? 0) > 0;
}

/** One-line "update available" notice, or null when there is nothing to say. */
export function updateNotice(state: UpdateState): string | null {
  if (!state.hasUpdate || !state.latest) return null;
  return (
    `A new routstrd version is available ` +
    `(v${state.current} \u2192 v${state.latest}). ` +
    `Run 'routstrd update' to update.`
  );
}
