import type { UsageTrackingEntry } from "../../daemon/types.ts";
import type { UsageSummary } from "../../daemon/http/usage-summary.ts";

export type { UsageSummary };

export interface UsageStats {
  entries: UsageTrackingEntry[];
  totalEntries: number;
  totalSatsCost: number;
  recentSatsCost: number;
  limit: number;
  /** Present when data was fetched via /usage/summary (server-aggregated path). */
  summary?: UsageSummary;
}

export interface DayStats {
  date: string;
  requests: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelStats {
  modelId: string;
  requests: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ProviderStats {
  baseUrl: string;
  requests: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ClientStats {
  client: string;
  requests: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type TabId = "overview" | "today" | "models" | "providers" | "tokens" | "clients" | "npubs" | "recent";

export interface Tab {
  id: TabId;
  name: string;
  key: string;
}

export interface NpubStats {
  npub: string;
  requests: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
