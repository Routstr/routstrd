import { isStandaloneExecutable } from "../runtime";
import { VERSION } from "../version";
import { getLatestStandaloneRelease } from "./standalone-update";

const NPM_REGISTRY = "https://registry.npmjs.org";
/** Bounds the update check so a stalled registry cannot hang `routstrd update`. */
const NPM_TIMEOUT_MS = 30_000;

/** Packages that `routstrd update` manages. */
export const UPDATE_PACKAGES = [
  { name: "routstrd", label: "routstrd" },
  { name: "@routstr/cocod", label: "cocod" },
] as const;

/**
 * Fetch the latest published version of a package from the npm registry.
 * Returns null if the version cannot be determined (e.g. offline, not found).
 */
export async function getLatestNpmVersion(
  packageName: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `${NPM_REGISTRY}/${encodeURIComponent(packageName)}/latest`,
      { signal: AbortSignal.timeout(NPM_TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the version of a globally-installed bun package.
 * Returns null when the package is not installed globally or the version
 * cannot be parsed as semver (e.g. installed from a git URL).
 */
export async function getGlobalPackageVersion(
  packageName: string,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(["bun", "pm", "ls", "-g"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    // Lines look like:  ├── routstrd@0.3.10   or   └── @routstr/cocod@0.0.24
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = output.match(new RegExp(`${escaped}@([^\\s]+)`));
    if (!match) return null;
    const version = match[1];
    // Reject non-semver versions (e.g. github:routstr/cocod#3f6ac14)
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) return null;
    return version;
  } catch {
    return null;
  }
}

type ParsedVersion = {
  core: [number, number, number];
  prerelease: string[] | null;
};

function parseVersion(version: string): ParsedVersion | null {
  const match = version.match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    core: [
      Number.parseInt(match[1], 10),
      Number.parseInt(match[2], 10),
      Number.parseInt(match[3], 10),
    ],
    prerelease: match[4]?.split(".") ?? null,
  };
}

function comparePrerelease(a: string[] | null, b: string[] | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      return Number.parseInt(left, 10) - Number.parseInt(right, 10);
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two semver version strings.
 * Returns a positive number if `a` is newer, negative if `b` is newer,
 * 0 if equal, or null if either value is not parseable semver.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  for (let index = 0; index < left.core.length; index++) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export interface PackageUpdate {
  name: string;
  label: string;
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  packages: PackageUpdate[];
}

export interface RoutstrdUpdateInfo {
  hasUpdate: boolean;
  /** Version of the code actually running right now. */
  current: string;
  /** Latest available version, or null when it could not be determined. */
  latest: string | null;
}

/** Overridable collaborators, so the install-layout logic is unit-testable. */
export interface RoutstrdCheckDeps {
  standalone: boolean;
  version: string;
  getLatestStandalone: typeof getLatestStandaloneRelease;
  getGlobalVersion: typeof getGlobalPackageVersion;
  getLatestNpm: typeof getLatestNpmVersion;
}

/**
 * Check only routstrd for an available update, for both install layouts:
 * standalone binaries are compared against the latest GitHub Release, while
 * npm/bun installs are compared against the npm registry.
 *
 * Best-effort: if the latest version cannot be fetched (offline, rate limited,
 * no release asset, ...) the running version is returned with `hasUpdate: false`
 * so callers can carry on without blocking.
 */
export async function checkRoutstrdUpdate(
  deps: Partial<RoutstrdCheckDeps> = {},
): Promise<RoutstrdUpdateInfo> {
  const standalone = deps.standalone ?? isStandaloneExecutable();
  const version = deps.version ?? VERSION;
  const getLatestStandalone =
    deps.getLatestStandalone ?? getLatestStandaloneRelease;
  const getGlobalVersion = deps.getGlobalVersion ?? getGlobalPackageVersion;
  const getLatestNpm = deps.getLatestNpm ?? getLatestNpmVersion;

  if (standalone) {
    let latest: string | null = null;
    try {
      latest = (await getLatestStandalone()).version;
    } catch {
      // Best-effort; fall through with hasUpdate: false.
    }
    return {
      hasUpdate: !!(latest && (compareVersions(version, latest) ?? -1) < 0),
      current: version,
      latest,
    };
  }

  const [installed, latest] = await Promise.all([
    getGlobalVersion("routstrd"),
    getLatestNpm("routstrd"),
  ]);
  // Only offer an npm/bun update when the running code really is that global
  // install. A source checkout (`bun src/index.ts ...`) reports the repo
  // version here, but `bun install -g routstrd` would not update it, so skip
  // those instead of nagging about an install the user is not running.
  const runningGlobalInstall =
    installed !== null && (compareVersions(installed, version) ?? -1) === 0;
  return {
    hasUpdate: !!(
      runningGlobalInstall &&
      latest &&
      (compareVersions(version, latest) ?? -1) < 0
    ),
    current: version,
    latest,
  };
}

/**
 * Check both routstrd and cocod for available updates.
 * Returns a result with per-package details and an overall `hasUpdate` flag.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (isStandaloneExecutable()) {
    let latest: string | null = null;
    try {
      latest = (await getLatestStandaloneRelease()).version;
    } catch {
      // Update checks are best-effort and must not disrupt the TUI.
    }
    const hasUpdate = !!(
      latest && (compareVersions(VERSION, latest) ?? -1) < 0
    );
    return {
      hasUpdate,
      packages: [
        {
          name: "routstrd",
          label: "routstrd",
          current: VERSION,
          latest,
          hasUpdate,
        },
      ],
    };
  }

  const packages = await Promise.all(
    UPDATE_PACKAGES.map(async ({ name, label }) => {
      const [current, latest] = await Promise.all([
        getGlobalPackageVersion(name),
        getLatestNpmVersion(name),
      ]);
      const hasUpdate = !!(current && latest && (compareVersions(current, latest) ?? -1) < 0);
      return { name, label, current, latest, hasUpdate } satisfies PackageUpdate;
    }),
  );
  return {
    hasUpdate: packages.some((p) => p.hasUpdate),
    packages,
  };
}
