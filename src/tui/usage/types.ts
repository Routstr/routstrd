import type { UsageTrackingEntry } from "../../daemon/types.ts";
import type { UsageSummary } from "../../daemon/http/usage-summary.ts";

export type { ErrorLogEntry } from "../../utils/logger.ts";
export type { UsageSummary };

export interface UsageStats {
  entries: UsageTrackingEntry[];
  totalEntries: number;
  totalSatsCost: number;
  recentSatsCost: number;
  limit: number;
  summary: UsageSummary;
}

export type TabId = "overview" | "today" | "models" | "providers" | "tokens" | "clients" | "npubs" | "recent" | "errors";

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
