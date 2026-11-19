import type { UsageTrackingEntry } from "../../daemon/types.ts";
import {
  MOTION_PREFIX_TIMEOUT_MS,
  type VimMode,
  type VimState,
} from "./types.ts";

/**
 * The TUI's key state.
 *
 * `mode` is the single source of truth for input handling: `search` swallows
 * printable keys into the query, `normal` dispatches them as motions and tab
 * switches. Earlier versions also carried an `isSearching` boolean that had to
 * be flipped by hand alongside `mode`, so a missed assignment left the search
 * bar rendering over a normal-mode keymap (or the reverse). Everything that
 * needs to know the mode now asks {@link isSearching} or reads `mode` directly.
 */
export const vimState: VimState = {
  scrollPos: 0,
  searchQuery: "",
  searchResults: [],
  currentSearchIdx: 0,
  mode: "normal",
  searchReverse: false,
  pendingMotion: null,
};

/** Whether the search prompt currently owns keyboard input. */
export function isSearching(): boolean {
  return vimState.mode === "search";
}

/**
 * Enter `mode`, clearing state that only belongs to the mode being left.
 *
 * `searchReverse` is deliberately preserved: it selects the prompt (`/` vs `?`)
 * *and* the direction `n`/`N` continue in after the prompt closes, so resetting
 * it here would flip a reverse search to forward on Enter.
 */
export function setMode(mode: VimMode): void {
  vimState.mode = mode;
  // A pending motion belongs to normal mode; leaving it set would let a `g`
  // pressed before `/` complete an `gg` after the search was dismissed.
  vimState.pendingMotion = null;
}

let maxScrollLines = 0;

export function clampScrollPos(contentHeight: number, viewportHeight: number): void {
  const maxScroll = Math.max(0, contentHeight - viewportHeight);
  vimState.scrollPos = Math.max(0, Math.min(vimState.scrollPos, maxScroll));
}

export function applyScrollToContent(content: string, viewportHeight: number): string {
  const lines = content.split("\n");
  maxScrollLines = Math.max(0, lines.length - Math.max(0, viewportHeight));
  clampScrollPos(lines.length, viewportHeight);

  if (viewportHeight <= 0) {
    return "";
  }

  return lines.slice(vimState.scrollPos, vimState.scrollPos + viewportHeight).join("\n");
}

export function scrollDown(lines = 1): void {
  vimState.scrollPos = Math.min(vimState.scrollPos + lines, maxScrollLines);
}

export function scrollUp(lines = 1): void {
  vimState.scrollPos = Math.max(vimState.scrollPos - lines, 0);
}

export function scrollToTop(): void {
  vimState.scrollPos = 0;
}

export function scrollToBottom(): void {
  vimState.scrollPos = maxScrollLines;
}

export function pageUp(): void {
  scrollUp(15);
}

export function pageDown(): void {
  scrollDown(15);
}

export function startSearch(reverse = false): void {
  vimState.searchReverse = reverse;
  vimState.searchQuery = "";
  setMode("search");
}

export function performSearch(query: string, entries: UsageTrackingEntry[]): void {
  vimState.searchQuery = query;
  vimState.searchResults = [];
  vimState.currentSearchIdx = 0;

  if (!query) {
    vimState.searchResults = [];
    return;
  }

  const lowerQuery = query.toLowerCase();
  entries.forEach((entry, idx) => {
    const searchable = [entry.modelId, entry.baseUrl || "", entry.client || ""].join(" ").toLowerCase();
    if (searchable.includes(lowerQuery)) {
      vimState.searchResults.push(idx);
    }
  });
}

export function nextSearchResult(totalEntries: number): void {
  if (vimState.searchResults.length === 0) return;
  vimState.currentSearchIdx = (vimState.currentSearchIdx + 1) % vimState.searchResults.length;
  vimState.scrollPos = Math.floor((vimState.searchResults[vimState.currentSearchIdx]! / Math.max(1, totalEntries)) * maxScrollLines);
}

export function prevSearchResult(totalEntries: number): void {
  if (vimState.searchResults.length === 0) return;
  vimState.currentSearchIdx = (vimState.currentSearchIdx - 1 + vimState.searchResults.length) % vimState.searchResults.length;
  vimState.scrollPos = Math.floor((vimState.searchResults[vimState.currentSearchIdx]! / Math.max(1, totalEntries)) * maxScrollLines);
}

export function exitSearchMode(): void {
  setMode("normal");
}

/**
 * Record a motion prefix and report whether it just completed a doubled motion.
 *
 * `gg` is two `g` presses inside {@link MOTION_PREFIX_TIMEOUT_MS}. The pending
 * prefix is a single nullable record, so "waiting for the second g" and "no
 * prefix" are the only representable states — the previous `lastKey`/`lastKeyTime`
 * pair also allowed "prefix waiting since the epoch", which silently expired.
 */
export function consumeMotionPrefix(key: string, now = Date.now()): boolean {
  const pending = vimState.pendingMotion;
  if (pending && pending.key === key && now - pending.at < MOTION_PREFIX_TIMEOUT_MS) {
    vimState.pendingMotion = null;
    return true;
  }
  vimState.pendingMotion = { key, at: now };
  return false;
}

/** Drop any pending motion prefix (used when another key interrupts it). */
export function clearPendingMotion(): void {
  vimState.pendingMotion = null;
}
