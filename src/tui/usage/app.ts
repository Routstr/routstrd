import { TABS } from "./constants.ts";
import { fetchBalance, fetchStatus, fetchUsage, type BalanceInfo, type StatusInfo } from "./data.ts";
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
import { isDaemonRunning } from "../../utils/daemon-client.ts";

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
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  let shouldUpdate = true;
  let autoRefresh = true;
  let cleanedUp = false;
  let rendering = false;

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

  async function render(forceFetch = false) {
    if (rendering) return;
    rendering = true;

    try {
      const width = getWidth();
      const height = getHeight();

      if (forceFetch || shouldUpdate) {
        stats = await fetchUsage(10000);
        balance = await fetchBalance();
        status = await fetchStatus();
        shouldUpdate = false;
      }

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

      const content = renderTabContent(currentTab, stats, balance, status, width);
      const footer = `${COLORS.dim}Press [Q] to quit, [R] to refresh, [A] to toggle auto-refresh${autoRefresh ? " (on)" : " (off)"}  scroll:${vimState.scrollPos}${COLORS.reset}${vimState.mode === "normal" ? `  ${COLORS.yellow}vim: hjkl/arrows, / search, g top, gg bottom${COLORS.reset}` : ""}`;
      const chrome = renderHeader(currentTab, width) + renderTabs(currentTab) + renderSeparator(width) + renderSearchBar();
      const chromeLines = chrome.split("\n").length - 1;
      const footerSeparator = renderSeparator(width);
      const footerLines = footerSeparator.split("\n").length - 1;
      const contentViewportHeight = Math.max(1, height - chromeLines - footerLines - 1);
      const visibleContent = applyScrollToContent(content, contentViewportHeight);
      const footerBlock = (visibleContent ? "\n" : "") + footerSeparator + footer;

      stdout.write(moveCursor(1, 1) + eraseDown() + chrome + visibleContent + footerBlock);
    } finally {
      rendering = false;
    }
  }

  const handleKey = (key: string) => {
    if (vimState.isSearching) {
      if (key === "\x1b" || key === "\x1b[3~") {
        exitSearchMode();
        void render(false);
        return;
      }
      if (key === "\r" || key === "\n") {
        if (stats?.entries) performSearch(vimState.searchQuery, stats.entries);
        exitSearchMode();
        void render(false);
        return;
      }
      if (key === "\x7f" || key === "\x08") {
        vimState.searchQuery = vimState.searchQuery.slice(0, -1);
        if (stats?.entries) performSearch(vimState.searchQuery, stats.entries);
        void render(false);
        return;
      }
      if (key === "\x03") {
        exitSearchMode();
        void render(false);
        return;
      }
      if (key.length === 1 && key.charCodeAt(0) >= 32 && key.charCodeAt(0) < 127) {
        vimState.searchQuery += key;
        if (stats?.entries) performSearch(vimState.searchQuery, stats.entries);
        void render(false);
      }
      return;
    }

    if (key === "q" || key === "Q" || key === "\u0003") return cleanup(0);
    if (key === "r" || key === "R") {
      shouldUpdate = true;
      void render(true);
      return;
    }
    if (key === "a" || key === "A") {
      autoRefresh = !autoRefresh;
      shouldUpdate = true;
      void render(false);
      return;
    }

    if (key === "j" || key === "\x1b[B" || key === "\x1bOB") {
      scrollDown();
      void render(false);
      return;
    }
    if (key === "k" || key === "\x1b[A" || key === "\x1bOA") {
      scrollUp();
      void render(false);
      return;
    }
    if (key === "l" || key === "\x1b[C" || key === "\x1bOC") {
      const currentIdx = TABS.findIndex((t) => t.id === currentTab);
      currentTab = TABS[(currentIdx + 1) % TABS.length]!.id;
      vimState.scrollPos = 0;
      void render(false);
      return;
    }
    if (key === "h" || key === "\x1b[D" || key === "\x1bOD") {
      const currentIdx = TABS.findIndex((t) => t.id === currentTab);
      currentTab = TABS[(currentIdx - 1 + TABS.length) % TABS.length]!.id;
      vimState.scrollPos = 0;
      void render(false);
      return;
    }

    if (key === "g") {
      if (vimState.lastKey === "g" && Date.now() - vimState.lastKeyTime < 300) {
        scrollToBottom();
        vimState.lastKey = "";
        void render(false);
        return;
      }
      vimState.lastKey = "g";
      vimState.lastKeyTime = Date.now();
      scrollToTop();
      void render(false);
      return;
    }

    if (key === "\x02") { pageUp(); void render(false); return; }
    if (key === "\x06") { pageDown(); void render(false); return; }
    if (key === "\x15") { scrollUp(10); void render(false); return; }
    if (key === "\x04") { scrollDown(10); void render(false); return; }
    if (key === "\x1b[H" || key === "\x1b[1~" || key === "\x1bOH") { scrollToTop(); void render(false); return; }
    if (key === "\x1b[F" || key === "\x1b[4~" || key === "\x1bOF") { scrollToBottom(); void render(false); return; }
    if (key === "/") { startSearch(false); void render(false); return; }
    if (key === "?") { startSearch(true); void render(false); return; }
    if (key === "n") {
      if (vimState.searchReverse) prevSearchResult(stats?.entries.length || 0);
      else nextSearchResult(stats?.entries.length || 0);
      void render(false);
      return;
    }
    if (key === "N") {
      if (vimState.searchReverse) nextSearchResult(stats?.entries.length || 0);
      else prevSearchResult(stats?.entries.length || 0);
      void render(false);
      return;
    }
    if (key === "\x1b") { scrollToTop(); void render(false); return; }

    const tab = TABS.find((t) => t.key === key);
    if (tab) {
      currentTab = tab.id;
      vimState.scrollPos = 0;
      void render(false);
    }
  };

  if (isInteractive) stdin.on("data", handleKey);

  await render(true);

  refreshInterval = setInterval(() => {
    if (autoRefresh) {
      shouldUpdate = true;
      void render(true);
    }
  }, 2000);
}
