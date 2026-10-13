import { loadConfig } from "../../utils/daemon-client.ts";
import { checkForUpdates, type UpdateCheckResult } from "../../utils/update-checker.ts";
import { isUpdateStateApplicable } from "../../utils/update-state.ts";
import { fetchVersionInfo, type VersionInfo } from "./data.ts";
import type { UpdateInfo } from "./types.ts";

export const VERSION_READ_INTERVAL_MS = 5 * 60 * 1000;
export const DIRECT_CHECK_INTERVAL_MS = 210 * 60 * 1000;

interface UpdatePollerDeps {
  loadConfig?: () => Promise<{ updateCheck?: boolean }>;
  fetchVersionInfo?: () => Promise<VersionInfo | null>;
  checkForUpdates?: () => Promise<UpdateCheckResult>;
  now?: () => number;
  publish: (info: UpdateInfo) => void;
}

/** Cached reads are cheap; legacy-daemon network checks retain their slow cadence. */
export function createUpdatePoller(deps: UpdatePollerDeps) {
  const config = deps.loadConfig ?? loadConfig;
  const readVersion = deps.fetchVersionInfo ?? fetchVersionInfo;
  const check = deps.checkForUpdates ?? checkForUpdates;
  const now = deps.now ?? Date.now;
  let lastRead: number | null = null;
  let lastDirectCheck: number | null = null;
  let running = false;

  return async function poll(): Promise<void> {
    const time = now();
    if (running || (lastRead !== null && time - lastRead < VERSION_READ_INTERVAL_MS)) return;
    running = true;
    // Record attempts, not just successes, to avoid retries on every TUI refresh.
    lastRead = time;
    try {
      if ((await config()).updateCheck === false) {
        deps.publish({ hasUpdate: false, text: "" });
        return;
      }
      const info = await readVersion();
      if (info) {
        const hasUpdate = info.checkedAt !== null && isUpdateStateApplicable(
          { ...info, checkedAt: info.checkedAt }, info.version, time,
        );
        deps.publish({
          hasUpdate,
          text: hasUpdate ? `Update available: routstrd ${info.latest}` : "",
        });
        return;
      }
      if (lastDirectCheck !== null && time - lastDirectCheck < DIRECT_CHECK_INTERVAL_MS) return;
      lastDirectCheck = time;
      const result = await check();
      const outdated = result.packages.filter((p) => p.hasUpdate);
      deps.publish({
        hasUpdate: result.hasUpdate,
        text: outdated.length > 0
          ? `Update available: ${outdated.map((p) => p.label).join(", ")} ${outdated.map((p) => p.latest).join(", ")}`
          : "",
      });
    } catch {
      // Update checks are best-effort and never interrupt the TUI.
    } finally {
      running = false;
    }
  };
}
