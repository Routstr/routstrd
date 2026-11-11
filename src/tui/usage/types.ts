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

/**
 * How long a motion prefix (`g`) waits for its second key.
 *
 * Exported so the "is this prefix still live?" decision is one function rather
 * than an inline `Date.now() - lastKeyTime < 300` comparison repeated in the
 * key handler.
 */
export const MOTION_PREFIX_TIMEOUT_MS = 300;

/**
 * The one input mode the TUI can be in.
 *
 * This is the *only* place mode is recorded. `isSearching` used to be a second
 * boolean kept in sync by hand, so the two could disagree — the search bar
 * drawn from one while keys were dispatched by the other. Read it through
 * `isSearching()` in state.ts instead of testing for a string.
 */
export type VimMode = "normal" | "search";

/**
 * A motion prefix awaiting its second key, e.g. the first `g` of `gg`.
 *
 * Modelled as one nullable record instead of the former `lastKey`/`lastKeyTime`
 * pair, which could represent "prefix `g` waiting since epoch 0" — a state that
 * meant nothing and expired instantly.
 */
export interface PendingMotion {
  /** The prefix key already pressed (`"g"`). */
  key: string;
  /** When it was pressed, for {@link MOTION_PREFIX_TIMEOUT_MS}. */
  at: number;
}

export interface VimState {
  scrollPos: number;
  searchQuery: string;
  searchResults: number[];
  currentSearchIdx: number;
  /** Authoritative input mode; search state below is only meaningful in `search`. */
  mode: VimMode;
  searchReverse: boolean;
  /** Prefix awaiting its second key, or null when none is pending. */
  pendingMotion: PendingMotion | null;
}
