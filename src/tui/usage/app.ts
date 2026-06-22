import { getVisibleTabs } from "./constants.ts";
import type { Tab } from "./types.ts";
import { fetchBalance, fetchClients, fetchStatus, fetchUsageSummary, hasAnyNpubs, isDaemonRunning, type BalanceInfo, type ClientInfo, type StatusInfo } from "./data.ts";
import {
  applyScrollToContent,
  exitSearchMode,
  nextSearchResult,
  pageDown,
  pageUp,
  performSearch,
  prevSearchResult,
  scrollDown,
  scrollToBottom,
  scrollToTop,
  scrollUp,
  startSearch,
  vimState,
} from "./state.ts";
import {
  enterAlternateScreen,
  eraseDown,
  getHeight,
  getWidth,
  hideCursor,
  leaveAlternateScreen,
  moveCursor,
  showCursor,
} from "./terminal.ts";
import { COLORS } from "./constants.ts";
import { renderHeader, renderSearchBar, renderSeparator, renderTabContent, renderTabs } from "./render.ts";
import type { TabId, UsageStats } from "./types.ts";

export async function runUsageTui(): Promise<void> {
  const running = await isDaemonRunning();
  if (!running) {
    console.log(`${COLORS.red}Error: routstrd daemon is not running.${COLORS.reset}`);
    console.log(`Run ${COLORS.green}routstrd start${COLORS.reset} first.`);
    process.exit(1);
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const isInteractive = Boolean(stdout.isTTY && stdin.isTTY);

  let currentTab: TabId = "overview";
  let stats: UsageStats | null = null;
  let balance: BalanceInfo | null = null;
  let status: StatusInfo | null = null;
  let clients: ClientInfo[] = [];
  let visibleTabs: Tab[] = getVisibleTabs(false);
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  let autoRefresh = true;
  let cleanedUp = false;
  let fetching = false;

  if (isInteractive) {
    stdout.write(enterAlternateScreen() + hideCursor());
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
  }

  function cleanup(exitCode = 0) {
    if (cleanedUp) return;
    cleanedUp = true;
    if (refreshInterval) clearInterval(refreshInterval);

    if (isInteractive) {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write(showCursor() + leaveAlternateScreen());
    } else {
      stdout.write(showCursor());
    }

    process.exit(exitCode);
  }

  process.on("SIGINT", () => cleanup(0));
  process.on("SIGTERM", () => cleanup(0));

  /**
   * Background fetch — async, never blocks rendering. Updates the state
   * variables only on success, then triggers a repaint. Overlapping calls
   * are skipped via the `fetching` guard so we don't race stale results.
   */
  async function fetchData(): Promise<void> {
    if (fetching) return;
    fetching = true;
    try {
      const running = await isDaemonRunning();
      if (!running) {
        stats = null;
      } else {
        // Fire all 4 fetches concurrently — cuts the blocked window significantly.
        const [newStats, newBalance, newStatus, newClients] = await Promise.all([
          fetchUsageSummary(),
          fetchBalance(),
          fetchStatus(),
          fetchClients(),
        ]);
        if (newStats) stats = newStats;
        if (newBalance) balance = newBalance;
        if (newStatus) status = newStatus;
        if (newClients && newClients.length > 0) clients = newClients;

        const npubsVisible = hasAnyNpubs(clients);
        visibleTabs = getVisibleTabs(npubsVisible);
        if (currentTab === "npubs" && !npubsVisible) {
          currentTab = "clients";
          vimState.scrollPos = 0;
        }
      }
      render();
    } finally {
      fetching = false;
    }
  }

  /**
   * Synchronous paint — never awaits I/O. Reads the current state variables
   * and writes to stdout. Safe to call from key handlers without blocking.
   */
  function render(): void {
    const width = getWidth();
    const height = getHeight();

    if (!stats) {
      stdout.write(
        moveCursor(1, 1) +
        eraseDown() +
        `${COLORS.red}Error: Could not fetch usage data.${COLORS.reset}\n` +
        `Make sure routstrd is running.\n` +
        `\nPress Q to quit.`
      );
      return;
    }

    const content = renderTabContent(currentTab, stats, balance, status, width, clients);
    const footer = `${COLORS.dim}Press [Q] to quit, [R] to refresh, [A] to toggle auto-refresh${autoRefresh ? " (on)" : " (off)"}  scroll:${vimState.scrollPos}${COLORS.reset}${vimState.mode === "normal" ? `  ${COLORS.yellow}vim: hjkl/arrows, / search, g top, gg bottom${COLORS.reset}` : ""}`;
    const chrome = renderHeader(currentTab, width, visibleTabs) + renderTabs(currentTab, visibleTabs) + renderSeparator(width) + renderSearchBar();
    const chromeLines = chrome.split("\n").length - 1;
    const footerSeparator = renderSeparator(width);
    const footerLines = footerSeparator.split("\n").length - 1;
    const contentViewportHeight = Math.max(1, height - chromeLines - footerLines - 1);
    const visibleContent = applyScrollToContent(content, contentViewportHeight);
    const footerBlock = (visibleContent ? "\n" : "") + footerSeparator + footer;

    stdout.write(moveCursor(1, 1) + eraseDown() + chrome + visibleContent + footerBlock);
  }

  const handleKey = (key: string) => {
    if (vimState.isSearching) {
      if (key === "\x1b" || key === "\x1b[3~") {
        exitSearchMode();
        render();
        return;
      }
      if (key === "\r" || key === "\n") {
        if (stats?.entries) performSearch(vimState.searchQuery, stats.entries);
        exitSearchMode();
        render();
        return;
      }
      if (key === "\x7f" || key === "\x08") {
        vimState.searchQuery = vimState.searchQuery.slice(0, -1);
        if (stats?.entries) performSearch(vimState.searchQuery, stats.entries);
        render();
        return;
      }
      if (key === "\x03") {
        exitSearchMode();
        render();
        return;
      }
      if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127) {
        vimState.searchQuery += key;
        if (stats?.entries) performSearch(vimState.searchQuery, stats.entries);
        render();
      }
      return;
    }

    if (key === "q" || key === "Q" || key === "\u0003") return cleanup(0);
    if (key === "r" || key === "R") {
      void fetchData();
      return;
    }
    if (key === "a" || key === "A") {
      autoRefresh = !autoRefresh;
      render();
      return;
    }

    if (key === "j" || key === "\x1b[B" || key === "\x1bOB") {
      scrollDown();
      render();
      return;
    }
    if (key === "k" || key === "\x1b[A" || key === "\x1bOA") {
      scrollUp();
      render();
      return;
    }
    if (key === "l" || key === "\x1b[C" || key === "\x1bOC") {
      const currentIdx = visibleTabs.findIndex((t) => t.id === currentTab);
      currentTab = visibleTabs[(currentIdx + 1) % visibleTabs.length]!.id;
      vimState.scrollPos = 0;
      render();
      return;
    }
    if (key === "h" || key === "\x1b[D" || key === "\x1bOD") {
      const currentIdx = visibleTabs.findIndex((t) => t.id === currentTab);
      currentTab = visibleTabs[(currentIdx - 1 + visibleTabs.length) % visibleTabs.length]!.id;
      vimState.scrollPos = 0;
      render();
      return;
    }

    if (key === "g") {
      if (vimState.lastKey === "g" && Date.now() - vimState.lastKeyTime < 300) {
        scrollToBottom();
        vimState.lastKey = "";
        render();
        return;
      }
      vimState.lastKey = "g";
      vimState.lastKeyTime = Date.now();
      scrollToTop();
      render();
      return;
    }

    if (key === "\x02") { pageUp(); render(); return; }
    if (key === "\x06") { pageDown(); render(); return; }
    if (key === "\x15") { scrollUp(10); render(); return; }
    if (key === "\x04") { scrollDown(10); render(); return; }
    if (key === "\x1b[H" || key === "\x1b[1~" || key === "\x1bOH") { scrollToTop(); render(); return; }
    if (key === "\x1b[F" || key === "\x1b[4~" || key === "\x1bOF") { scrollToBottom(); render(); return; }
    if (key === "/") { startSearch(false); render(); return; }
    if (key === "?") { startSearch(true); render(); return; }
    if (key === "n") {
      if (vimState.searchReverse) prevSearchResult(stats?.entries.length || 0);
      else nextSearchResult(stats?.entries.length || 0);
      render();
      return;
    }
    if (key === "N") {
      if (vimState.searchReverse) nextSearchResult(stats?.entries.length || 0);
      else prevSearchResult(stats?.entries.length || 0);
      render();
      return;
    }
    if (key === "\x1b") { scrollToTop(); render(); return; }

    const tab = visibleTabs.find((t) => t.key === key);
    if (tab) {
      currentTab = tab.id;
      vimState.scrollPos = 0;
      render();
    }
  };

  if (isInteractive) stdin.on("data", handleKey);

  await fetchData();

  refreshInterval = setInterval(() => {
    if (autoRefresh) {
      void fetchData();
    }
  }, 2000);
}
