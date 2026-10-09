import type { Tab, TimeWindow } from "./types.ts";

export const ALL_TABS: Tab[] = [
  { id: "overview", name: "Overview", key: "1" },
  { id: "today", name: "Today", key: "2" },
  { id: "models", name: "Models", key: "3" },
  { id: "providers", name: "Providers", key: "4" },
  { id: "tokens", name: "Tokens", key: "5" },
  { id: "clients", name: "Clients", key: "6" },
  { id: "npubs", name: "Npubs", key: "7" },
  { id: "recent", name: "Recent", key: "8" },
];

/**
 * Returns the visible tab list, hiding the Npubs tab when no clients
 * have an ownerNpub. Keys are re-assigned sequentially (1..N).
 */
export function getVisibleTabs(hasNpubs: boolean): Tab[] {
  const tabs = ALL_TABS.filter((t) => t.id !== "npubs" || hasNpubs);
  return tabs.map((t, i) => ({ ...t, key: String(i + 1) }));
}

/** Default tab list (no npub data yet). */
export const TABS: Tab[] = getVisibleTabs(false);

// ─── Time windows ─────────────────────────────────────────────────────────────

/** Cycle order for the `[W]` key: all → today → 7d → 30d → all. */
export const WINDOW_ORDER: readonly TimeWindow[] = ["all", "today", "7d", "30d"];

/** Short labels shown in the window selector bar. */
export const WINDOW_LABELS: Record<TimeWindow, string> = {
  all: "All",
  today: "24h",
  "7d": "7d",
  "30d": "30d",
};

/** Advance/rewind through {@link WINDOW_ORDER}, wrapping at either end. */
export function cycleTimeWindow(current: TimeWindow, direction: 1 | -1): TimeWindow {
  const idx = WINDOW_ORDER.indexOf(current);
  const next = (idx + direction + WINDOW_ORDER.length) % WINDOW_ORDER.length;
  return WINDOW_ORDER[next]!;
}

/** Whether the active window applies to a given tab. */
export function tabSupportsWindow(tabId: Tab["id"]): boolean {
  return tabId !== "overview" && tabId !== "today" && tabId !== "recent";
}

export const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bright: "\x1b[1m",
};

export const MODEL_COLORS: Record<string, string> = {
  "gpt-5.4": COLORS.magenta,
  "minimax-m2.7": COLORS.cyan,
  default: COLORS.white,
};

export const CLIENT_COLORS: Record<string, string> = {
  opencode: COLORS.blue,
  openclaw: COLORS.green,
  "pi-agent": COLORS.yellow,
  unknown: COLORS.dim,
  default: COLORS.white,
};
