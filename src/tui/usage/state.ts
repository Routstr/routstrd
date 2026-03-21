import type { UsageTrackingEntry } from "../../daemon/types.ts";
import type { VimState } from "./types.ts";

export const vimState: VimState = {
  scrollPos: 0,
  searchQuery: "",
  searchResults: [],
  currentSearchIdx: 0,
  isSearching: false,
  searchReverse: false,
  mode: "normal",
  lastKey: "",
  lastKeyTime: 0,
};

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
  vimState.isSearching = true;
  vimState.searchReverse = reverse;
  vimState.searchQuery = "";
  vimState.mode = "search";
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
  vimState.isSearching = false;
  vimState.mode = "normal";
}
