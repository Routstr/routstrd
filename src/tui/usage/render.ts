import { CLIENT_COLORS, COLORS, MODEL_COLORS, WINDOW_LABELS, WINDOW_ORDER, tabShowsWindowBarInChrome } from "./constants.ts";
import type { Tab } from "./types.ts";
import {
  formatNumber,
  formatTime,
  resolveClientLabel,
  type ClientNaming,
} from "./data.ts";
import { vimState } from "./state.ts";
import { stripAnsi, truncateAnsi } from "./terminal.ts";
import type { BalanceInfo, StatusInfo } from "./data.ts";
import type { TabId, TimeWindow, TimelineBucket, TimelinePoint, UpdateInfo, UsageStats } from "./types.ts";

/** Format a cost value: 0.12, 1.23, 12.34, 123.45, 1.23k, 1.23m */
function formatCost(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + "m";
  if (value >= 1_000) return (value / 1_000).toFixed(2) + "k";
  return value.toFixed(2);
}

/** Format request count: 1, 12, 123, 1.2k, 1.2m */
function formatReqs(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "m";
  if (value >= 1_000) return (value / 1_000).toFixed(1) + "k";
  return value.toString();
}

export function renderHeader(activeTab: TabId, width: number, visibleTabs: Tab[], updateInfo?: UpdateInfo): string {
  const title = `${COLORS.bold}${COLORS.cyan}ROUTSTRD USAGE MONITOR${COLORS.reset}`;
  const vimIndicator = `${COLORS.yellow}[vim]${COLORS.reset}`;
  const maxKey = visibleTabs.length;
  const help = `${COLORS.dim}[Q] Quit  [↑↓] Scroll  [←→] Tabs  [1-${maxKey}] Tabs  [W] Window  [R] Refresh${COLORS.reset}`;
  const fill = width - title.length - help.length - vimIndicator.length - 6;
  const headerLine = `${title}${vimIndicator}${" ".repeat(Math.max(1, fill))}${help}`;

  if (updateInfo?.hasUpdate) {
    const banner = `${COLORS.bold}${COLORS.yellow}  ↻ UPDATE AVAILABLE — run ${COLORS.green}routstrd update${COLORS.yellow} to update${COLORS.reset}`;
    return `${headerLine}\n${banner}\n`;
  }

  return `${headerLine}\n`;
}

export function renderSearchBar(): string {
  if (!vimState.isSearching) return "";
  const prompt = vimState.searchReverse ? "?" : "/";
  const matches = vimState.searchResults.length > 0
    ? ` (${vimState.currentSearchIdx + 1}/${vimState.searchResults.length})`
    : "";
  const searchLine = `${COLORS.yellow}${prompt}${COLORS.reset}${vimState.searchQuery}${COLORS.dim}_${COLORS.reset}${matches} `;
  const placeholder = `${COLORS.dim}type to search, Enter to confirm, Esc to cancel${COLORS.reset}`;
  return `\n${searchLine}${placeholder}\n`;
}

export function renderTabs(activeTab: TabId, visibleTabs: Tab[]): string {
  const tabStr = visibleTabs.map((tab) => tab.id === activeTab
    ? `${COLORS.bgBlue} ${tab.key}:${tab.name} ${COLORS.reset}`
    : `${COLORS.dim}[${tab.key}]${COLORS.reset} ${tab.name}`).join("  ");
  return `${" ".repeat(2)}${tabStr}\n`;
}

/** The `All 24h 7d 30d` choices with the active one highlighted. */
function windowChoices(activeWindow: TimeWindow): string {
  return WINDOW_ORDER.map((id) => id === activeWindow
    ? `${COLORS.bgGreen}${COLORS.bold} ${WINDOW_LABELS[id]} ${COLORS.reset}`
    : `${COLORS.dim}${WINDOW_LABELS[id]}${COLORS.reset}`).join("  ");
}

/**
 * Time-window selector line for the top chrome. Tabs that ignore the window
 * (Recent) render nothing at all — a selector that cannot be acted on is
 * noise — and Overview renders it inline instead (see
 * {@link renderWindowSelector}).
 */
export function renderWindowBar(activeWindow: TimeWindow, activeTab: TabId): string {
  if (!tabShowsWindowBarInChrome(activeTab)) return "";

  return `  ${COLORS.dim}window:${COLORS.reset} ${windowChoices(activeWindow)}\n`;
}

/**
 * Inline window selector. Overview draws this inside its content, directly
 * under the Balance box, because the chrome bar scrolls away from the figures
 * it scopes. It carries its own `[W]` hint since the header isn't next to it.
 */
export function renderWindowSelector(activeWindow: TimeWindow): string {
  return `${windowChoices(activeWindow)}   ${COLORS.dim}[W] cycle${COLORS.reset}`;
}

export function renderSeparator(width: number): string {
  return `${COLORS.dim}${"─".repeat(width)}${COLORS.reset}\n`;
}

export function renderBox(lines: string[], width: number, title?: string): string {
  const result: string[] = [];
  const innerWidth = Math.max(0, width - 4);
  
  if (title) {
    const titleStr = ` ${title} `;
    const dashCount = Math.max(0, width - 2 - titleStr.length - 1);
    result.push(`┌─${titleStr}${"─".repeat(dashCount)}┐`);
  } else {
    result.push(`┌${"─".repeat(Math.max(0, width - 2))}┐`);
  }
  
  for (const rawLine of lines) {
    // Truncate first so an overlong line can never push the right border out.
    const line = truncateAnsi(rawLine, innerWidth);
    const padding = Math.max(0, innerWidth - stripAnsi(line).length);
    result.push(`│ ${line}${" ".repeat(padding)} │`);
  }
  result.push(`└${"─".repeat(Math.max(0, width - 2))}┘`);
  return result.join("\n");
}

const _sectionMaxLabelLen = new Map<string, number>();

export function startBarSection(sectionKey: string, maxLabelLen: number): void {
  _sectionMaxLabelLen.set(sectionKey, maxLabelLen);
}

export function endBarSection(_sectionKey: string): void {
  // kept for API compat; no-op since we compute max per call now
}

export function renderBarChart(
  label: string,
  value: number,
  maxValue: number,
  width: number,
  color: string,
  percentageValue?: number,
  sectionKey?: string,
): string {
  const safeMaxValue = Math.max(maxValue, 1);
  const pct = percentageValue !== undefined
    ? percentageValue.toFixed(1)
    : ((value / safeMaxValue) * 100).toFixed(1);
  const suffix = ` ${pct}%`;

  const maxLen = sectionKey ? (_sectionMaxLabelLen.get(sectionKey) ?? label.length) : label.length;
  const paddedLabel = label.padEnd(maxLen);
  const reserved = suffix.length + 1;
  const maxBarWidth = Math.max(0, width - paddedLabel.length - reserved);
  const barLen = Math.max(0, Math.round((value / safeMaxValue) * maxBarWidth));
  const bar = color + "█".repeat(barLen) + COLORS.reset;
  return `${paddedLabel} ${bar}${suffix}`;
}


/** Merge two rendered boxes into rows of full width, padding the shorter one. */
function combineSideBySide(left: string, right: string, leftWidth: number, rightWidth: number): string {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const rows = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = leftLines[i] || " ".repeat(leftWidth);
    const r = rightLines[i] || " ".repeat(rightWidth);
    lines.push(l + r);
  }
  return lines.join("\n");
}

export function renderOverview(
  stats: UsageStats,
  balance: BalanceInfo | null,
  status: StatusInfo | null,
  width: number,
  activeWindow: TimeWindow,
): string {
  // Overview honours the [W] window selector: every figure below is scoped to
  // the selected window, so "Total Spent" means "spent in this window".
  const totals = stats.window.totals;
  const totalRequests = totals.requests;
  const totalVisibleCost = totals.satsCost;
  const avgCost = totalRequests > 0 ? totalVisibleCost / totalRequests : 0;
  const avgTokens = totalRequests > 0 ? totals.totalTokens / totalRequests : 0;

  const leftBox = [
    `${COLORS.bold}Total Spent:${COLORS.reset} ${COLORS.green}${formatCost(totalVisibleCost)} sats${COLORS.reset}`,
    `${COLORS.bold}Total Requests:${COLORS.reset} ${formatReqs(totalRequests)}`,
    `${COLORS.bold}Avg Cost/Req:${COLORS.reset} ${formatCost(avgCost)} sats`,
  ];

  const rightBox = [
    `${COLORS.bold}Total Tokens:${COLORS.reset} ${formatNumber(totals.totalTokens)}`,
    `${COLORS.bold}Avg Tokens/Req:${COLORS.reset} ${formatNumber(Math.round(avgTokens))}`,
    `${COLORS.bold}Prompt/Comp:${COLORS.reset} ${(totals.promptTokens / Math.max(1, totals.completionTokens)).toFixed(2)}x`,
  ];

  const halfWidth1 = Math.floor(width / 2);
  const halfWidth2 = width - halfWidth1;

  const statusLines: string[] = [];
  if (status) {
    const daemonColor = status.daemon === "running" ? COLORS.green : COLORS.red;
    const walletColor = status.wallet === "connected" ? COLORS.green : COLORS.red;
    const modeColor = COLORS.cyan;
    statusLines.push(`${COLORS.bold}Daemon:${COLORS.reset} ${daemonColor}${status.daemon}${COLORS.reset}`);
    if (status.url) {
      const label = "Running on: ";
      const maxUrlLen = Math.max(8, halfWidth2 - 4 - label.length);
      const url = status.url.length > maxUrlLen
        ? `${status.url.slice(0, Math.max(0, maxUrlLen - 1))}…`
        : status.url;
      statusLines.push(`${COLORS.bold}${label}${COLORS.reset} ${COLORS.cyan}${url}${COLORS.reset}`);
    }
    statusLines.push(`${COLORS.bold}Wallet:${COLORS.reset} ${walletColor}${status.wallet}${COLORS.reset}`);
    statusLines.push(`${COLORS.bold}Mode:${COLORS.reset} ${modeColor}${status.mode}${COLORS.reset}`);
    if (status.error) {
      statusLines.push(`${COLORS.bold}Error:${COLORS.reset} ${COLORS.red}${status.error}${COLORS.reset}`);
    }
  } else {
    statusLines.push(`${COLORS.dim}Status unavailable${COLORS.reset}`);
  }

  const sections: string[] = [];

  // Balance and status boxes side by side.
  if (balance) {
    const balanceLines: string[] = [];
    const totalBalance = balance.total;

    if (totalBalance > 0) {
      balanceLines.push(`${COLORS.bold}Total Balance:${COLORS.reset} ${COLORS.green}${totalBalance.toLocaleString()} sat${COLORS.reset}`);
    } else {
      balanceLines.push(`${COLORS.bold}Total Balance:${COLORS.reset} ${COLORS.red}0 sat${COLORS.reset}`);
    }

    for (const key of balance.keys) {
      const color = key.id === "wallet" ? COLORS.green : COLORS.cyan;
      if (key.id === "wallet") {
        balanceLines.push(`${color}Wallet:${COLORS.reset} ${key.balance.toLocaleString()} sat`);
      } else {
        // Extract provider URL from name (e.g., "API Key: https://..." or "Cached: https://...")
        const providerUrl = key.name.replace(/^(API Key|Cached):\s*/, "");
        const shortProvider = providerUrl.replace("https://", "").replace("http://", "");
        const label = key.id.startsWith("cached:") ? "Cached" : "API Key";
        balanceLines.push(`${color}${label}:${COLORS.reset} ${shortProvider} (${key.balance.toLocaleString()} sat)`);
      }
    }

    if (totalBalance === 0) {
      balanceLines.push(`${COLORS.dim}No funds available${COLORS.reset}`);
    }

    sections.push(combineSideBySide(
      renderBox(balanceLines, halfWidth1, "Balance"),
      renderBox(statusLines, halfWidth2, "System Status"),
      halfWidth1,
      halfWidth2,
    ));
  } else {
    // No balance data — status takes the full width.
    sections.push(renderBox(statusLines, width, "System Status"));
  }

  // Window selector, directly under the Balance box: it scopes everything that
  // follows, so it reads as part of the balance/status header rather than as
  // tab chrome (which the Overview content scrolls away from).
  sections.push(renderBox([renderWindowSelector(activeWindow)], width, "Time Window"));

  sections.push(combineSideBySide(
    renderBox(leftBox, halfWidth1, "Stats of Sats"),
    renderBox(rightBox, halfWidth2, "Token Stats"),
    halfWidth1,
    halfWidth2,
  ));

  const modelStats = stats.window.models;
  if (modelStats.length > 0) {
    const maxCost = modelStats[0]!.satsCost;
    const totalCost = Math.max(totalVisibleCost, 1);
    const maxModelLabel = Math.max(...modelStats.slice(0, 5).map((m) => m.modelId.length)) + 1;
    startBarSection("models", maxModelLabel);
    const modelLines = modelStats.slice(0, 5).map((m) => renderBarChart(
      m.modelId + " ",
      m.satsCost,
      maxCost,
      width - 4,
      MODEL_COLORS[m.modelId] || MODEL_COLORS.default || COLORS.white,
      (m.satsCost / totalCost) * 100,
      "models",
    ));
    endBarSection("models");
    sections.push(renderBox(modelLines, width, "Top Models by Cost"));
  }

  const clientStats = stats.window.clients;
  if (clientStats.length > 0) {
    const maxCost = clientStats[0]!.satsCost;
    const totalCost = Math.max(totalVisibleCost, 1);
    const maxClientLabel = Math.max(...clientStats.slice(0, 5).map((c) => c.client.length)) + 1;
    startBarSection("clients", maxClientLabel);
    const clientLines = clientStats.slice(0, 5).map((c) => renderBarChart(
      c.client + " ",
      c.satsCost,
      maxCost,
      width - 4,
      CLIENT_COLORS[c.client] || CLIENT_COLORS.default || COLORS.white,
      (c.satsCost / totalCost) * 100,
      "clients",
    ));
    endBarSection("clients");
    sections.push(renderBox(clientLines, width, "Usage by Client"));
  }

  return sections.join("\n");
}

/** Format a sats value compactly for the chart's y-axis: 0, 42, 1.2k, 3.4M. */
function formatSatsAxis(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + "M";
  if (value >= 1_000) return (value / 1_000).toFixed(1) + "k";
  if (value >= 100 || Number.isInteger(value)) return String(Math.round(value));
  return String(Number(value.toPrecision(3)));
}

/** Round up to a readable 1/2/5 × power-of-ten axis ceiling. */
function niceAxisCeiling(peak: number): number {
  if (peak <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  const normalized = peak / magnitude;
  const step = [1, 2, 5, 10].find((value) => normalized <= value)!;
  return step * magnitude;
}

/** Axis tick label for a bucket: `09` (hour) or `05-20` (day/week). */
function timelineAxisLabel(point: TimelinePoint, bucket: TimelineBucket): string {
  if (bucket === "hour") return point.key;
  return point.key.slice(5); // MM-DD
}

/** Fold adjacent buckets together so a long series still fits the columns. */
function mergeTimelinePoints(points: TimelinePoint[], groupSize: number): TimelinePoint[] {
  const merged: TimelinePoint[] = [];
  for (let i = 0; i < points.length; i += groupSize) {
    const chunk = points.slice(i, i + groupSize);
    const first = chunk[0]!;
    merged.push({
      key: first.key,
      timestamp: first.timestamp,
      requests: chunk.reduce((sum, p) => sum + p.requests, 0),
      satsCost: chunk.reduce((sum, p) => sum + p.satsCost, 0),
      totalTokens: chunk.reduce((sum, p) => sum + p.totalTokens, 0),
      promptTokens: chunk.reduce((sum, p) => sum + p.promptTokens, 0),
      completionTokens: chunk.reduce((sum, p) => sum + p.completionTokens, 0),
    });
  }
  return merged;
}

/** Columns kept between the spend bar and the token bar of one bucket (none). */
const BAR_INNER_GAP = 0;
/** Columns kept between two buckets. */
const BAR_GROUP_GAP = 1;

/**
 * Dual-axis grouped bar chart. For every bucket an orange spend bar (left axis,
 * sats) is drawn flush against a cyan token bar (right axis, tokens), with a
 * gap between buckets so pairs read as pairs.
 *
 * `width` is the columns available inside the surrounding box; `height` is the
 * number of bar rows.
 */
export function renderTimelineChart(
  points: TimelinePoint[],
  bucket: TimelineBucket,
  width: number,
  height = 10,
): string[] {
  if (points.length === 0) return ["No activity in this window"];

  const maxCost = Math.max(...points.map((p) => p.satsCost), 0);
  const maxTokens = Math.max(...points.map((p) => p.totalTokens), 0);
  if (maxCost <= 0 && maxTokens <= 0) return ["No activity in this window"];

  const rows = Math.max(1, Math.floor(height));
  const minGroupCols = 2 + BAR_INNER_GAP + BAR_GROUP_GAP;
  let groupSize = 1;
  let slots = points;
  let costCeiling: number;
  let tokenCeiling: number;
  let costTicks: string[];
  let tokenTicks: string[];
  let leftCol: number;
  let rightCol: number;
  let leftGutter: number;
  let plotWidth: number;

  // Merging changes peaks and potentially label widths. Recompute the axes
  // after each merge; groupSize only grows, so this always terminates.
  for (;;) {
    slots = groupSize === 1 ? points : mergeTimelinePoints(points, groupSize);
    costCeiling = niceAxisCeiling(Math.max(...slots.map((p) => p.satsCost), 0));
    tokenCeiling = niceAxisCeiling(Math.max(...slots.map((p) => p.totalTokens), 0));
    costTicks = [formatSatsAxis(costCeiling), formatSatsAxis(costCeiling / 2), "0"];
    tokenTicks = [formatNumber(tokenCeiling), formatNumber(tokenCeiling / 2), "0"];
    leftCol = Math.max(...costTicks.map((t) => t.length));
    rightCol = Math.max(...tokenTicks.map((t) => t.length));
    leftGutter = leftCol + 2; // "<label> ┤"
    const rightGutter = rightCol + 2; // "├ <label>"
    plotWidth = Math.max(1, width - leftGutter - rightGutter);
    const maxGroups = Math.max(1, Math.floor(plotWidth / minGroupCols));
    if (slots.length <= maxGroups) break;
    groupSize = Math.max(groupSize + 1, Math.ceil(points.length / maxGroups));
  }
  const n = slots.length;

  const groupCols = Math.max(minGroupCols, Math.floor(plotWidth / n));
  const barWidth = Math.max(1, Math.floor((groupCols - BAR_INNER_GAP - BAR_GROUP_GAP) / 2));
  const groupUsed = 2 * barWidth + BAR_INNER_GAP + BAR_GROUP_GAP;
  const trailing = " ".repeat(Math.max(0, groupCols - groupUsed));
  const plotPad = " ".repeat(Math.max(0, plotWidth - n * groupCols));

  const costHeights = slots.map((p) => Math.round((p.satsCost / costCeiling) * rows));
  const tokenHeights = slots.map((p) => Math.round((p.totalTokens / tokenCeiling) * rows));

  const lines: string[] = [];
  // Headroom row: the peak ticks float one row above the tallest bar, so a
  // full-cell block glyph can never look like it overshoots its own axis.
  lines.push(
    costTicks[0]!.padStart(leftCol) + " " + COLORS.dim + "┤" + COLORS.reset +
    " ".repeat(Math.max(0, plotWidth)) +
    COLORS.dim + "├" + COLORS.reset + " " + tokenTicks[0]!.padEnd(rightCol),
  );

  const midRow = Math.floor((rows - 1) / 2);
  for (let row = 0; row < rows; row++) {
    const filledFromBottom = rows - row;
    let plot = "";
    for (let c = 0; c < n; c++) {
      const costOn = costHeights[c]! >= filledFromBottom;
      const tokenOn = tokenHeights[c]! >= filledFromBottom;
      plot += costOn ? COLORS.orange + "█".repeat(barWidth) : " ".repeat(barWidth);
      plot += " ".repeat(BAR_INNER_GAP);
      plot += tokenOn ? COLORS.cyan + "█".repeat(barWidth) : " ".repeat(barWidth);
      plot += trailing + " ".repeat(BAR_GROUP_GAP);
    }
    plot += plotPad;

    const leftLabel = row === midRow ? costTicks[1]! : "";
    const rightLabel = row === midRow ? tokenTicks[1]! : "";
    const left = leftLabel.padStart(leftCol) + " " + COLORS.dim + "┤" + COLORS.reset;
    const right = COLORS.dim + "├" + COLORS.reset + " " + rightLabel.padEnd(rightCol);
    lines.push(left + plot + COLORS.reset + right);
  }

  // Bottom axis, carrying the `0` tick on both sides.
  lines.push(
    "0".padStart(leftCol) + " " + COLORS.dim + "└" + "─".repeat(plotWidth) + "┘" + COLORS.reset +
    " " + "0".padEnd(rightCol),
  );

  // X labels, placed under the first column of their bucket.
  const labelLine: string[] = [];
  let cursor = 0;
  for (let c = 0; c < n; c++) {
    const column = c * groupCols;
    if (column < cursor) continue;
    const text = timelineAxisLabel(slots[c]!, bucket);
    while (labelLine.length < column) labelLine.push(" ");
    labelLine.push(...text);
    cursor = column + text.length + 1;
  }
  lines.push(" ".repeat(leftGutter) + COLORS.dim + labelLine.slice(0, plotWidth).join("") + COLORS.reset);

  // Legend, truncated so it can never widen the box.
  const legendLimit = Math.max(0, width - leftGutter);
  const legendSegments: Array<{ text: string; color: string }> = [
    { text: "█", color: COLORS.orange },
    { text: " spend   ", color: "" },
    { text: "█", color: COLORS.cyan },
    { text: " tokens   ", color: "" },
    { text: "left: sats · right: tokens", color: COLORS.dim },
  ];
  let legend = "";
  let legendUsed = 0;
  for (const segment of legendSegments) {
    if (legendUsed >= legendLimit) break;
    const text = segment.text.slice(0, legendLimit - legendUsed);
    // Reset first so an earlier `dim` segment can't wash out this swatch.
    legend += COLORS.reset + segment.color + text;
    legendUsed += text.length;
  }
  lines.push(" ".repeat(leftGutter) + legend + COLORS.reset);

  return lines;
}

const HISTORY_WINDOW_LABELS: Record<TimeWindow, string> = {
  all: "all time",
  today: "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

const HISTORY_CHART_TITLES: Record<TimeWindow, string> = {
  all: "Spend per week",
  today: "Spend per hour",
  "7d": "Spend per 6 hours",
  "30d": "Spend per day",
};

export function renderHistory(stats: UsageStats, width: number, height?: number): string {
  const win = stats.window;
  const timeline = win.timeline ?? { bucket: "day" as const, points: [] };
  const totals = win.totals;

  const summaryLine =
    COLORS.dim + "spent " + COLORS.reset + COLORS.green + formatCost(totals.satsCost) + " sats" + COLORS.reset +
    COLORS.dim + "   reqs " + COLORS.reset + formatReqs(totals.requests) +
    COLORS.dim + "   tokens " + COLORS.reset + formatNumber(totals.totalTokens) +
    COLORS.dim + "   avg " + COLORS.reset +
    formatCost(totals.requests > 0 ? totals.satsCost / totals.requests : 0) + " sats" + COLORS.reset;

  // Fill the viewport: summary box (3) + chart box borders (2) + the chart's
  // own headroom/axis/labels/legend (4) are chrome around the bar rows.
  const chartHeight = height === undefined
    ? 10
    : Math.max(4, Math.min(40, height - 9));

  const summary = renderBox([summaryLine], width, "History — " + HISTORY_WINDOW_LABELS[win.window]);
  const chart = renderBox(
    renderTimelineChart(timeline.points, timeline.bucket, width - 4, chartHeight),
    width,
    HISTORY_CHART_TITLES[win.window],
  );
  return summary + "\n" + chart;
}

export function renderModels(stats: UsageStats, width: number): string {
  const modelStats = stats.window.models;
  if (modelStats.length === 0) return renderBox(["No model data available"], width, "Models");

  // Percentages are relative to the selected window's total cost.
  const totalCost = stats.window.totals.satsCost;
  const maxCost = modelStats[0]!.satsCost;
  const maxModelLabel = Math.max(...modelStats.map((m) => m.modelId.length));
  const lines: string[] = [];

  startBarSection("model-detail", maxModelLabel);
  for (const model of modelStats) {
    const color = MODEL_COLORS[model.modelId] || MODEL_COLORS.default || COLORS.white;
    const pct = totalCost > 0 ? ((model.satsCost / totalCost) * 100).toFixed(1) : "0.0";
    lines.push(`${color}${COLORS.bold}${model.modelId}${COLORS.reset}`);
    lines.push(`  ${COLORS.dim}Cost:${COLORS.reset} ${formatCost(model.satsCost)} sats (${pct}%)`);
    lines.push(`  ${COLORS.dim}Requests:${COLORS.reset} ${formatReqs(model.requests)}`);
    lines.push(`  ${COLORS.dim}Tokens:${COLORS.reset} ${formatNumber(model.totalTokens)}`);
    lines.push(`  ${COLORS.dim}Avg:${COLORS.reset} ${formatCost(model.satsCost / model.requests)} sats/req`);
    lines.push(`  ${renderBarChart("  ", model.satsCost, maxCost, width - 6, color, Number(pct), "model-detail")}`);
    lines.push("");
  }
  endBarSection("model-detail");

  return renderBox(lines, width, "Model Breakdown");
}

export function renderProviders(stats: UsageStats, width: number): string {
  const providerStats = stats.window.providers;
  if (providerStats.length === 0) return renderBox(["No provider data available"], width, "Providers");

  const lines: string[] = [];
  for (const provider of providerStats) {
    const shortUrl = provider.baseUrl.replace("https://", "").replace("http://", "");
    lines.push(`${COLORS.cyan}${COLORS.bold}${shortUrl}${COLORS.reset}`);
    lines.push(`  ${COLORS.dim}Requests:${COLORS.reset} ${formatReqs(provider.requests)}`);
    lines.push(`  ${COLORS.dim}Cost:${COLORS.reset} ${formatCost(provider.satsCost)} sats`);
    lines.push(`  ${COLORS.dim}Tokens:${COLORS.reset} ${formatNumber(provider.totalTokens)}`);
    lines.push("");
  }
  return renderBox(lines, width, "Provider Breakdown");
}

export function renderTokens(stats: UsageStats, width: number): string {
  const totals = stats.window.totals;
  const modelStats = stats.window.models;
  const summaryLines = [
    `${COLORS.bold}Total Prompt Tokens:${COLORS.reset} ${formatNumber(totals.promptTokens)}`,
    `${COLORS.bold}Total Completion Tokens:${COLORS.reset} ${formatNumber(totals.completionTokens)}`,
    `${COLORS.bold}Total Tokens:${COLORS.reset} ${formatNumber(totals.totalTokens)}`,
    `${COLORS.bold}Prompt/Completion Ratio:${COLORS.reset} ${(totals.promptTokens / Math.max(1, totals.completionTokens)).toFixed(2)}x`,
    `${COLORS.bold}Avg Tokens/Request:${COLORS.reset} ${(totals.totalTokens / Math.max(1, totals.requests)).toFixed(0)}`,
  ];

  let output = renderBox(summaryLines, width, "Token Summary");

  if (modelStats.length > 0) {
    const tokenLines = modelStats.slice(0, 6).map((m) => {
      const color = MODEL_COLORS[m.modelId] || MODEL_COLORS.default;
      const promptPct = m.totalTokens > 0 ? ((m.promptTokens / m.totalTokens) * 100).toFixed(0) : "0";
      return `${color}${m.modelId.padEnd(15)}${COLORS.reset} ${formatNumber(m.totalTokens).padStart(8)} tokens (${promptPct}% prompt)`;
    });
    output += "\n" + renderBox(tokenLines, width, "Tokens by Model");
  }

  const sizeBuckets = stats.window.sizeBuckets;

  const sizeLines = Object.entries(sizeBuckets).map(([name, bucket]) => `${name.padEnd(6)}: ${formatReqs(bucket.count).padStart(5)} reqs, ${formatCost(bucket.cost)} sats`);
  output += "\n" + renderBox(sizeLines, width, "Request Size Distribution");
  return output;
}

export function renderClients(stats: UsageStats, width: number): string {
  const clientStats = stats.window.clients;
  if (clientStats.length === 0) return renderBox(["No client data available (API key auth not used)"], width, "Client Breakdown");

  // Percentages are relative to the selected window's total cost.
  const totalCost = stats.window.totals.satsCost;
  const maxCost = clientStats[0]!.satsCost;
  const lines: string[] = [];

  const col1 = 20; // Client
  const col2 = 12; // Requests
  const col3 = 24; // Cost
  const col4 = 12; // Tokens

  const hClient = "Client".padEnd(col1);
  const hReqs = "Requests".padEnd(col2);
  const hCost = "Cost".padEnd(col3);
  const hTok = "Tokens".padEnd(col4);
  lines.push(`${COLORS.bold}${hClient}${hReqs}${hCost}${hTok}Avg Cost${COLORS.reset}`);
  lines.push(COLORS.dim + "─".repeat(Math.max(0, width - 4)) + COLORS.reset);

  startBarSection("client-detail", 20); // match col1
  for (const client of clientStats) {
    const color = CLIENT_COLORS[client.client] || CLIENT_COLORS.default || COLORS.white;
    const pct = totalCost > 0 ? ((client.satsCost / totalCost) * 100).toFixed(1) : "0.0";
    const avgCostFormatted = formatCost(client.requests > 0 ? client.satsCost / client.requests : 0);
    
    const dClient = client.client.slice(0, col1 - 1).padEnd(col1);
    const dReqs = formatReqs(client.requests).padEnd(col2);
    const dCost = `${formatCost(client.satsCost)} sats (${pct}%)`.padEnd(col3);
    const dTok = formatNumber(client.totalTokens).padEnd(col4);
    const dAvg = `${avgCostFormatted} sats/req`;

    lines.push(
      `${color}${COLORS.bold}${dClient}${COLORS.reset}` +
      `${dReqs}` +
      `${COLORS.green}${dCost}${COLORS.reset}` +
      `${COLORS.dim}${dTok}${dAvg}${COLORS.reset}`
    );
    lines.push(`  ${renderBarChart("", client.satsCost, maxCost, width - 6, color, Number(pct), "client-detail")}`);
    lines.push("");
  }
  endBarSection("client-detail");

  let output = renderBox(lines, width, "Client Breakdown");
  const clientModelLines: string[] = [];

  if (stats.summary) {
    // Use pre-aggregated topModels from summary; exclude the "unknown" bucket
    // (null client rows have no meaningful model attribution to display here).
    for (const topClient of stats.window.clients.filter((c) => c.client !== "unknown").slice(0, 3)) {
      if (topClient.topModels.length === 0) continue;
      clientModelLines.push(`${COLORS.bold}${topClient.client}${COLORS.reset} (${formatReqs(topClient.requests)} reqs, ${formatCost(topClient.satsCost)} sats)`);
      for (const m of topClient.topModels) {
        clientModelLines.push(`  ${(MODEL_COLORS[m.modelId] || MODEL_COLORS.default)}${m.modelId.padEnd(18)}${COLORS.reset} ${formatNumber(m.totalTokens).padEnd(8)} tokens  ${formatCost(m.satsCost)} sats`);
      }
      clientModelLines.push("");
    }
  }

  if (clientModelLines.length > 0) {
    output += "\n" + renderBox(clientModelLines, width, "Top Models per Client");
  }
  return output;
}

export function renderNpubs(stats: UsageStats, naming: ClientNaming, width: number): string {
  const npubStats = stats.window.npubs;
  if (npubStats.length === 0) return renderBox(["No npub data available"], width, "Npub Breakdown");

  // Index configured npubs by their npub so usage rows can show names/roles.
  const configured = new Map(naming.npubs.map((entry) => [entry.npub, entry]));

  const totalCost = stats.window.totals.satsCost;
  const maxCost = npubStats[0]!.satsCost;
  const lines: string[] = [];

  const col1 = 24; // Name (or truncated npub)
  const col2 = 12; // Requests
  const col3 = 24; // Cost
  const col4 = 12; // Tokens

  const hNpub = "Name".padEnd(col1);
  const hReqs = "Requests".padEnd(col2);
  const hCost = "Cost".padEnd(col3);
  const hTok = "Tokens".padEnd(col4);
  lines.push(`${COLORS.bold}${hNpub}${hReqs}${hCost}${hTok}Avg Cost${COLORS.reset}`);
  lines.push(COLORS.dim + "─".repeat(Math.max(0, width - 4)) + COLORS.reset);

  startBarSection("npub-detail", col1);
  for (const npub of npubStats) {
    const pct = totalCost > 0 ? ((npub.satsCost / totalCost) * 100).toFixed(1) : "0.0";
    const avgCostFormatted = formatCost(npub.requests > 0 ? npub.satsCost / npub.requests : 0);
    const entry = configured.get(npub.npub);
    const name = entry?.name?.trim();
    const label = name || truncateNpub(npub.npub);

    const dNpub = label.slice(0, col1 - 1).padEnd(col1);
    const dReqs = formatReqs(npub.requests).padEnd(col2);
    const dCost = `${formatCost(npub.satsCost)} sats (${pct}%)`.padEnd(col3);
    const dTok = formatNumber(npub.totalTokens).padEnd(col4);
    const dAvg = `${avgCostFormatted} sats/req`;

    lines.push(
      `${COLORS.magenta}${COLORS.bold}${dNpub}${COLORS.reset}` +
      `${dReqs}` +
      `${COLORS.green}${dCost}${COLORS.reset}` +
      `${COLORS.dim}${dTok}${dAvg}${COLORS.reset}`
    );
    // Full npub (and role when known) on its own line for copy-ability.
    const roleSuffix = entry?.role ? ` [${entry.role}]` : "";
    lines.push(`  ${COLORS.dim}${npub.npub}${roleSuffix}${COLORS.reset}`);
    lines.push(`  ${renderBarChart("", npub.satsCost, maxCost, width - 6, COLORS.magenta, Number(pct), "npub-detail")}`);
    lines.push("");
  }
  endBarSection("npub-detail");

  let output = renderBox(lines, width, "Npub Breakdown");
  const npubModelLines: string[] = [];

  if (stats.summary) {
    // Use pre-aggregated topModels from summary
    for (const topNpub of stats.window.npubs.slice(0, 5)) {
      if (topNpub.topModels.length === 0) continue;
      const name = configured.get(topNpub.npub)?.name?.trim();
      const label = name || truncateNpub(topNpub.npub);
      npubModelLines.push(`${COLORS.bold}${label}${COLORS.reset} (${formatReqs(topNpub.requests)} reqs, ${formatCost(topNpub.satsCost)} sats)`);
      for (const m of topNpub.topModels) {
        npubModelLines.push(`  ${(MODEL_COLORS[m.modelId] || MODEL_COLORS.default)}${m.modelId.padEnd(18)}${COLORS.reset} ${formatNumber(m.totalTokens).padEnd(8)} tokens  ${formatCost(m.satsCost)} sats`);
      }
      npubModelLines.push("");
    }
  }

  if (npubModelLines.length > 0) {
    output += "\n" + renderBox(npubModelLines, width, "Top Models per Npub");
  }

  return output;
}

/** Truncate an npub for display: first 10 chars + … + last 6 chars. */
function truncateNpub(npub: string): string {
  if (npub.length <= 24) return npub;
  return npub.slice(0, 10) + "…" + npub.slice(-6);
}

/**
 * Token breakdown of a single request, split the way the TUI colours it:
 * input read from the prompt cache (green) vs input that was not (red,
 * i.e. cache writes plus uncached input), plus output tokens.
 */
export interface TokenSegments {
  /** Input tokens served from the prompt cache. */
  cacheRead: number;
  /** Input tokens that were not served from the cache. */
  notCached: number;
  /** Total input tokens, cached and not. */
  input: number;
  output: number;
  /** Input + output. */
  total: number;
}

/**
 * Split a usage entry into cache read / not-cached input and output tokens.
 *
 * Providers report prompt tokens inconsistently: OpenAI-style `prompt_tokens`
 * already includes the cached subsets, while Anthropic-style `input_tokens`
 * reports them alongside. If the prompt is at least as large as the cached
 * counts it is treated as containing them (OpenAI); otherwise the cached
 * counts are extra (Anthropic). `input` is the sum of what is drawn rather
 * than a possibly under-counted `totalTokens`.
 */
export function tokenSegments(entry: {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): TokenSegments {
  const cacheRead = Math.max(0, entry.cacheReadInputTokens || 0);
  const cacheWrite = Math.max(0, entry.cacheCreationInputTokens || 0);
  const prompt = Math.max(0, entry.promptTokens || 0);
  const output = Math.max(0, entry.completionTokens || 0);
  const cached = cacheRead + cacheWrite;
  const uncachedInput = prompt >= cached ? prompt - cached : prompt;
  const notCached = cacheWrite + uncachedInput;
  const input = cacheRead + notCached;
  return { cacheRead, notCached, input, output, total: input + output };
}

/** One coloured slice of a {@link renderStackedBar}. */
export interface BarSegment {
  /** Segment magnitude; negatives are treated as zero. */
  value: number;
  /** ANSI escape applied to this segment's cells. */
  color: string;
}

/**
 * Render a fixed-width stacked bar: `trackWidth` cells split between the
 * segments in proportion to their values, so the bar conveys *composition*
 * (magnitude is reported separately, e.g. as the token total beside it).
 *
 * Cell counts use largest-remainder rounding, so the segments always fill
 * exactly `trackWidth` cells. A row with no tokens renders as an empty track.
 */
export function renderStackedBar(segments: BarSegment[], trackWidth: number): string {
  const track = Math.max(0, Math.floor(trackWidth));
  if (track === 0) return "";

  const values = segments.map((segment) => Math.max(0, segment.value));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return " ".repeat(track);

  const exact = values.map((value) => (value / total) * track);
  const cells = exact.map((value) => Math.floor(value));
  let remaining = track - cells.reduce((sum, value) => sum + value, 0);

  // Largest-remainder: leftover cells go to the biggest fractional parts.
  const remainders = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < remainders.length && remaining > 0; i++, remaining--) {
    cells[remainders[i]!.index]! += 1;
  }

  const bar = segments
    .map((segment, i) => (cells[i]! > 0 ? `${segment.color}${"█".repeat(cells[i]!)}` : ""))
    .join("");
  return bar.length > 0 ? bar + COLORS.reset : " ".repeat(track);
}

/** Colour coding for the Recent tab's cache-hit bars. */
const TOKEN_BAR_COLORS = {
  cacheRead: COLORS.green,
  notCached: COLORS.red,
};

export function renderRecent(stats: UsageStats, width: number, naming: ClientNaming): string {
  const recentEntries = stats.entries.slice(0, 50);
  if (recentEntries.length === 0) return renderBox(["No recent entries"], width, "Recent Requests");

  const timeCol = 8;
  const costCol = 12;
  // Width reserved left of the token counts for the cache-hit bar. `CACHE HIT`
  // is the header drawn over the bar, so the bar can never be narrower.
  const minBarWidth = "CACHE HIT".length;
  const maxBarWidth = 20;
  const minProviderCol = 12;
  const minModelCol = 10;
  const minClientCol = 6;

  // Remote mode: `Alice (claude-code)` — owner display name + the client id
  // with the `-<npub tail>` suffix stripped. Local mode (no owner/name data)
  // keeps the previous behaviour: the raw id in a fixed 14-col cell.
  const hasOwnerInfo = naming.npubs.length > 0 || naming.ownersByClientId.size > 0;
  const clientLabels = recentEntries.map((entry) =>
    hasOwnerInfo ? resolveClientLabel(entry.client, naming) : entry.client || "unknown"
  );
  const maxLabelLen = clientLabels.reduce((max, label) => Math.max(max, label.length), 6);

  // Token counts are drawn as `IN - OUT` with IN pinned to the left edge of the
  // column and OUT to the right, so both halves need the widest value on show.
  const tokenRows = recentEntries.map((entry) => tokenSegments(entry));
  const inputTexts = tokenRows.map((row) => formatNumber(row.input));
  const outputTexts = tokenRows.map((row) => formatNumber(row.output));
  const inputCol = Math.max(...inputTexts.map((text) => text.length));
  const outputCol = Math.max(...outputTexts.map((text) => text.length));
  const inOutCol = inputCol + outputCol + " - ".length;

  // Lay out the columns against the box's inner width: start from the widest
  // layout, hand the slack to the provider column, then give space back in
  // priority order (bar, provider, model, client) until everything fits.
  const innerWidth = Math.max(0, width - 4);
  let modelCol = 18;
  let clientCol = hasOwnerInfo ? Math.min(32, Math.max(14, maxLabelLen)) : 14;
  let barWidth = maxBarWidth;
  let showProvider = false;
  let providerCol = 0;
  // Column widths plus one separator between each visible column.
  const usedWidth = () =>
    timeCol + modelCol + (barWidth + 1 + inOutCol) + costCol + clientCol +
    (showProvider ? providerCol + 1 : 0) + 4;

  if (innerWidth - usedWidth() > minProviderCol + 1) {
    showProvider = true;
    providerCol = innerWidth - usedWidth();
  }
  while (usedWidth() > innerWidth && barWidth > minBarWidth) barWidth -= 1;
  while (usedWidth() > innerWidth && providerCol > minProviderCol) providerCol -= 1;
  while (usedWidth() > innerWidth && modelCol > minModelCol) modelCol -= 1;
  while (usedWidth() > innerWidth && clientCol > minClientCol) clientCol -= 1;

  const tokensCol = barWidth + 1 + inOutCol;

  const lines: string[] = [];
  const header = [
    "TIME".padEnd(timeCol),
    "MODEL".padEnd(modelCol),
    "CACHE HIT".padEnd(tokensCol - inOutCol) + "IN".padEnd(inputCol) + " - " + "OUT".padStart(outputCol),
    // Right-aligned like the values below it, so the column's right edge is
    // shared by the header and every `n sats` cell.
    "COST".padStart(costCol),
    ...(showProvider ? ["BASE:PROVIDER".padEnd(providerCol)] : []),
    "CLIENT".padEnd(clientCol),
  ];
  lines.push(`${COLORS.bold}${header.join(" ")}${COLORS.reset}`);
  lines.push(COLORS.dim + "─".repeat(innerWidth) + COLORS.reset);

  for (let i = 0; i < recentEntries.length; i++) {
    const entry = recentEntries[i]!;
    const time = formatTime(entry.timestamp).slice(0, 8);
    const model = entry.modelId.slice(0, modelCol).padEnd(modelCol);
    const segments = tokenRows[i]!;
    const bar = renderStackedBar([
      { value: segments.cacheRead, color: TOKEN_BAR_COLORS.cacheRead },
      { value: segments.notCached, color: TOKEN_BAR_COLORS.notCached },
    ], barWidth);
    const tokens = `${bar} ${inputTexts[i]!.padEnd(inputCol)} - ${outputTexts[i]!.padStart(outputCol)}`;
    const totalSats = typeof entry.totalMsats === "number" ? entry.totalMsats / 1000 : entry.satsCost;
    // Right-aligned so the `sats` unit ends at the same column on every row.
    const cost = `${formatCost(totalSats)} sats`.padStart(costCol);
    const baseUrl = (entry.baseUrl || "unknown").replace("https://", "").replace("http://", "");
    const provider = `${baseUrl}:${entry.provider || "unknown"}`.slice(0, providerCol).padEnd(providerCol);
    const clientLabel = clientLabels[i]!.slice(0, clientCol).padEnd(clientCol);
    const clientColor = CLIENT_COLORS[entry.client || "unknown"] || CLIENT_COLORS.default || COLORS.white;
    const modelColor = MODEL_COLORS[entry.modelId] || MODEL_COLORS.default;
    lines.push([
      `${COLORS.dim}${time}${COLORS.reset}`,
      `${modelColor}${model}${COLORS.reset}`,
      tokens,
      `${COLORS.green}${cost.padEnd(costCol)}${COLORS.reset}`,
      ...(showProvider ? [`${COLORS.dim}${provider}${COLORS.reset}`] : []),
      `${clientColor}${clientLabel}${COLORS.reset}`,
    ].join(" "));
  }

  return renderBox(lines, width, `Recent Requests (${stats.entries.length} shown)`);
}

export function renderTabContent(activeTab: TabId, stats: UsageStats, balance: BalanceInfo | null, status: StatusInfo | null, width: number, naming: ClientNaming, activeWindow: TimeWindow, height?: number): string {
  switch (activeTab) {
    case "overview": return renderOverview(stats, balance, status, width, activeWindow);
    case "history": return renderHistory(stats, width, height);
    case "models": return renderModels(stats, width);
    case "providers": return renderProviders(stats, width);
    case "tokens": return renderTokens(stats, width);
    case "clients": return renderClients(stats, width);
    case "npubs": return renderNpubs(stats, naming, width);
    case "recent": return renderRecent(stats, width, naming);
    default: return "Unknown tab";
  }
}
