import type { UsageTrackingEntry } from "../../daemon/types.ts";
import type {
  TimeWindow,
  UsageSummary,
  WindowedStats,
  Timeline,
  TimelineBucket,
  TimelinePoint,
} from "../../daemon/http/usage-summary.ts";

export type { UsageSummary, TimeWindow, WindowedStats, Timeline, TimelineBucket, TimelinePoint };

export interface UpdateInfo {
  hasUpdate: boolean;
  text: string;
}

export interface UsageStats {
  entries: UsageTrackingEntry[];
  totalEntries: number;
  totalSatsCost: number;
  recentSatsCost: number;
  limit: number;
  summary: UsageSummary;
  /** False when connected to a daemon without selectable-window summaries. */
  supportsWindows?: boolean;
  /** Aggregates for the currently selected time window. */
  window: WindowedStats;
}

export type TabId = "overview" | "history" | "models" | "providers" | "clients" | "npubs" | "recent";

export interface Tab {
  id: TabId;
  name: string;
  key: string;
}

export interface VimState {
  scrollPos: number;
  searchQuery: string;
  searchResults: number[];
  currentSearchIdx: number;
  isSearching: boolean;
  searchReverse: boolean;
  mode: "normal" | "search";
  lastKey: string;
  lastKeyTime: number;
}
