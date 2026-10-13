import { cycleTimeWindow } from "./constants.ts";
import type { TimeWindow, UsageStats } from "./types.ts";

export const LEGACY_WINDOW_NOTICE = "All-time usage only: upgrade the daemon to enable time windows.";

/** Window selection and caching shared by fetching and key handling. */
export function createWindowSelection() {
  const cache = new Map<TimeWindow, UsageStats>();
  let currentWindow: TimeWindow = "all";
  let supportsWindows = true;
  return {
    get currentWindow() { return currentWindow; },
    get supportsWindows() { return supportsWindows; },
    get notice() { return supportsWindows ? "" : LEGACY_WINDOW_NOTICE; },
    accept(requestedWindow: TimeWindow, stats: UsageStats): UsageStats | null {
      // A legacy response is authoritative even if the user switched while
      // fetching: none of the filtered cache entries can be trusted anymore.
      supportsWindows = stats.supportsWindows ?? Boolean(stats.summary.window);
      if (!supportsWindows) {
        cache.clear();
        currentWindow = "all";
        cache.set("all", stats);
        return stats;
      }
      cache.set(stats.window.window, stats);
      // Do not paint a late response over a newer selection.
      if (requestedWindow !== currentWindow) return null;
      currentWindow = stats.window.window;
      return stats;
    },
    cycle(direction: 1 | -1): UsageStats | null {
      if (!supportsWindows) return cache.get("all") ?? null;
      currentWindow = cycleTimeWindow(currentWindow, direction);
      return cache.get(currentWindow) ?? null;
    },
  };
}
