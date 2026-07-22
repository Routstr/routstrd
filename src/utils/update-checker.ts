const NPM_REGISTRY = "https://registry.npmjs.org";

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

/**
 * Compare two semver version strings.
 * Returns a positive number if `a` is newer, negative if `b` is newer,
 * 0 if equal, or null if either value is not parseable semver.
 */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): [number, number, number] | null => {
    const match = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match?.[1] || !match[2] || !match[3]) return null;
    return [
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      parseInt(match[3], 10),
    ];
  };
  const va = parse(a);
  const vb = parse(b);
  if (!va || !vb) return null;
  const [a1, a2, a3] = va;
  const [b1, b2, b3] = vb;
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  if (a3 !== b3) return a3 - b3;
  return 0;
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

/**
 * Check both routstrd and cocod for available updates.
 * Returns a result with per-package details and an overall `hasUpdate` flag.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
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
