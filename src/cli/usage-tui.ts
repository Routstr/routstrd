/**
 * routstrd Usage Monitor TUI
 * 
 * An htop-like terminal UI for monitoring routstr usage stats.
 * Navigate with arrow keys or number keys (1-6) for tabs.
 * 
 * Usage: bun run src/cli/usage-tui.ts
 */

import type { UsageTrackingEntry } from "../daemon/types.ts";
import { callDaemon, ensureDaemonRunning, isDaemonRunning } from "../cli-shared.ts";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface UsageStats {
  entries: UsageTrackingEntry[];
  totalEntries: number;
  totalSatsCost: number;
  recentSatsCost: number;
  limit: number;
}

interface DayStats {
  date: string;
  requests: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface ModelStats {
  modelId: string;
  requests: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface ProviderStats {
  baseUrl: string;
  requests: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

type TabId = "overview" | "today" | "models" | "providers" | "tokens" | "recent";

interface Tab {
  id: TabId;
  name: string;
  key: string;
}

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const TABS: Tab[] = [
  { id: "overview", name: "Overview", key: "1" },
  { id: "today", name: "Today", key: "2" },
  { id: "models", name: "Models", key: "3" },
  { id: "providers", name: "Providers", key: "4" },
  { id: "tokens", name: "Tokens", key: "5" },
  { id: "recent", name: "Recent", key: "6" },
];

const COLORS = {
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

const MODEL_COLORS: Record<string, string> = {
  "gpt-5.4": COLORS.magenta,
  "minimax-m2.7": COLORS.cyan,
  "default": COLORS.white,
};

// ═══════════════════════════════════════════════════════════════
// ANSI Escape Helpers
// ═══════════════════════════════════════════════════════════════

function clearScreen(): string {
  return "\x1b[2J\x1b[H";
}

function hideCursor(): string {
  return "\x1b[?25l";
}

function showCursor(): string {
  return "\x1b[?25h";
}

function moveCursor(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

function saveCursor(): string {
  return "\x1b[s";
}

function restoreCursor(): string {
  return "\x1b[u";
}

function eraseLine(): string {
  return "\x1b[2K";
}

function eraseDown(): string {
  return "\x1b[J";
}

function getWidth(): number {
  return process.stdout.columns || 80;
}

function getHeight(): number {
  return process.stdout.rows || 24;
}

// ═══════════════════════════════════════════════════════════════
// Data Fetching
// ═══════════════════════════════════════════════════════════════

async function fetchUsage(limit = 1000): Promise<UsageStats | null> {
  try {
    const running = await isDaemonRunning();
    if (!running) {
      return null;
    }

    const result = await callDaemon(`/usage?limit=${limit}`);
    if (result.error) {
      return null;
    }

    const output = result.output as {
      entries?: UsageTrackingEntry[];
      totalEntries?: number;
      totalSatsCost?: number;
      recentSatsCost?: number;
      limit?: number;
    };

    return {
      entries: output?.entries || [],
      totalEntries: output?.totalEntries || 0,
      totalSatsCost: output?.totalSatsCost || 0,
      recentSatsCost: output?.recentSatsCost || 0,
      limit: output?.limit || limit,
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Data Analysis
// ═══════════════════════════════════════════════════════════════

function getTodayStart(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[0];
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().split("T")[1].slice(0, 8);
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toString();
}

function getDayStats(entries: UsageTrackingEntry[]): Map<string, DayStats> {
  const days = new Map<string, DayStats>();
  
  for (const entry of entries) {
    const date = formatDate(entry.timestamp);
    const existing = days.get(date) || {
      date,
      requests: 0,
      satsCost: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    
    days.set(date, {
      ...existing,
      requests: existing.requests + 1,
      satsCost: existing.satsCost + entry.satsCost,
      promptTokens: existing.promptTokens + entry.promptTokens,
      completionTokens: existing.completionTokens + entry.completionTokens,
      totalTokens: existing.totalTokens + entry.totalTokens,
    });
  }
  
  return days;
}

function getHourlyToday(entries: UsageTrackingEntry[]): Map<number, DayStats> {
  const todayStart = getTodayStart();
  const hours = new Map<number, DayStats>();
  
  for (const entry of entries) {
    if (entry.timestamp < todayStart) continue;
    
    const hour = new Date(entry.timestamp).getHours();
    const existing = hours.get(hour) || {
      date: formatDate(entry.timestamp),
      requests: 0,
      satsCost: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    
    hours.set(hour, {
      ...existing,
      requests: existing.requests + 1,
      satsCost: existing.satsCost + entry.satsCost,
      promptTokens: existing.promptTokens + entry.promptTokens,
      completionTokens: existing.completionTokens + entry.completionTokens,
      totalTokens: existing.totalTokens + entry.totalTokens,
    });
  }
  
  return hours;
}

function getModelStats(entries: UsageTrackingEntry[]): ModelStats[] {
  const models = new Map<string, ModelStats>();
  
  for (const entry of entries) {
    const existing = models.get(entry.modelId) || {
      modelId: entry.modelId,
      requests: 0,
      satsCost: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    
    models.set(entry.modelId, {
      ...existing,
      requests: existing.requests + 1,
      satsCost: existing.satsCost + entry.satsCost,
      promptTokens: existing.promptTokens + entry.promptTokens,
      completionTokens: existing.completionTokens + entry.completionTokens,
      totalTokens: existing.totalTokens + entry.totalTokens,
    });
  }
  
  return Array.from(models.values()).sort((a, b) => b.satsCost - a.satsCost);
}

function getProviderStats(entries: UsageTrackingEntry[]): ProviderStats[] {
  const providers = new Map<string, ProviderStats>();
  
  for (const entry of entries) {
    const url = entry.baseUrl || "unknown";
    const existing = providers.get(url) || {
      baseUrl: url,
      requests: 0,
      satsCost: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    
    providers.set(url, {
      ...existing,
      requests: existing.requests + 1,
      satsCost: existing.satsCost + entry.satsCost,
      promptTokens: existing.promptTokens + entry.promptTokens,
      completionTokens: existing.completionTokens + entry.completionTokens,
      totalTokens: existing.totalTokens + entry.totalTokens,
    });
  }
  
  return Array.from(providers.values()).sort((a, b) => b.satsCost - a.satsCost);
}

function getTotals(entries: UsageTrackingEntry[]) {
  return entries.reduce(
    (acc, entry) => ({
      promptTokens: acc.promptTokens + entry.promptTokens,
      completionTokens: acc.completionTokens + entry.completionTokens,
      totalTokens: acc.totalTokens + entry.totalTokens,
      satsCost: acc.satsCost + entry.satsCost,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, satsCost: 0 }
  );
}

// ═══════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════

function renderHeader(activeTab: TabId, width: number): string {
  const title = `${COLORS.bold}${COLORS.cyan}ROUTSTRD USAGE MONITOR${COLORS.reset}`;
  const help = `${COLORS.dim}[Q] Quit  [↑↓] Scroll  [1-6] Tabs  [R] Refresh${COLORS.reset}`;
  const fill = width - title.length - help.length - 4;
  
  return `${title}${" ".repeat(Math.max(1, fill))}${help}\n`;
}

function renderTabs(activeTab: TabId, width: number): string {
  const tabStr = TABS.map((tab) => {
    if (tab.id === activeTab) {
      return `${COLORS.bgBlue} ${tab.key}:${tab.name} ${COLORS.reset}`;
    }
    return `${COLORS.dim}[${tab.key}]${COLORS.reset} ${tab.name}`;
  }).join("  ");
  
  return `${" ".repeat(2)}${tabStr}\n`;
}

function renderSeparator(width: number): string {
  return `${COLORS.dim}${"─".repeat(width)}${COLORS.reset}\n`;
}

function renderBox(lines: string[], width: number, title?: string): string {
  const result: string[] = [];
  const innerWidth = width - 4;
  
  result.push(`┌─${title ? ` ${title} ` : " "}${("─".repeat(innerWidth - (title?.length || 0) - 2))}─┐`);
  
  for (const line of lines) {
    const padding = innerWidth - stripAnsi(line).length;
    result.push(`│ ${line}${" ".repeat(Math.max(0, padding))} │`);
  }
  
  result.push(`└${"─".repeat(width - 2)}─┘`);
  return result.join("\n");
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderBarChart(
  label: string,
  value: number,
  maxValue: number,
  width: number,
  color: string
): string {
  const maxBarWidth = width - label.length - 20;
  const barLen = Math.round((value / maxValue) * maxBarWidth);
  const bar = color + "█".repeat(barLen) + COLORS.reset;
  const pct = maxValue > 0 ? ((value / maxValue) * 100).toFixed(1) : "0.0";
  
  return `${label.padEnd(width - maxBarWidth - 15)}${bar} ${pct}%`;
}

function renderOverview(stats: UsageStats, width: number): string {
  const totals = getTotals(stats.entries);
  const avgCost = stats.totalEntries > 0 
    ? stats.totalSatsCost / stats.totalEntries 
    : 0;
  const avgTokens = stats.totalEntries > 0 
    ? totals.totalTokens / stats.totalEntries 
    : 0;
  
  const halfWidth = Math.floor((width - 6) / 2);
  
  const leftBox = [
    `${COLORS.bold}Total Spent:${COLORS.reset} ${COLORS.green}${stats.totalSatsCost.toFixed(3)} sats${COLORS.reset}`,
    `${COLORS.bold}Total Requests:${COLORS.reset} ${formatNumber(stats.totalEntries)}`,
    `${COLORS.bold}Avg Cost/Req:${COLORS.reset} ${avgCost.toFixed(3)} sats`,
  ].map((l) => l.padEnd(halfWidth));
  
  const rightBox = [
    `${COLORS.bold}Total Tokens:${COLORS.reset} ${formatNumber(totals.totalTokens)}`,
    `${COLORS.bold}Avg Tokens/Req:${COLORS.reset} ${formatNumber(Math.round(avgTokens))}`,
    `${COLORS.bold}Prompt/Comp:${COLORS.reset} ${(totals.promptTokens / Math.max(1, totals.completionTokens)).toFixed(2)}x`,
  ].map((l) => l.padEnd(halfWidth));
  
  let output = renderBox(leftBox, width, "Summary Stats");
  output += "\n" + renderBox(rightBox, width, "Token Stats");
  
  // Quick model breakdown
  const modelStats = getModelStats(stats.entries);
  if (modelStats.length > 0) {
    const maxCost = modelStats[0].satsCost;
    const modelLines = modelStats.slice(0, 5).map((m) => {
      const color = MODEL_COLORS[m.modelId] || MODEL_COLORS.default;
      return renderBarChart(m.modelId, m.satsCost, maxCost, width - 4, color);
    });
    output += "\n" + renderBox(modelLines, width, "Top Models by Cost");
  }
  
  return output;
}

function renderToday(stats: UsageStats, width: number): string {
  const hourly = getHourlyToday(stats.entries);
  const todayStart = getTodayStart();
  const now = new Date();
  const currentHour = now.getHours();
  
  const todayStats: DayStats = {
    date: formatDate(Date.now()),
    requests: 0,
    satsCost: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  
  for (const entry of stats.entries) {
    if (entry.timestamp >= todayStart) {
      todayStats.requests++;
      todayStats.satsCost += entry.satsCost;
      todayStats.promptTokens += entry.promptTokens;
      todayStats.completionTokens += entry.completionTokens;
      todayStats.totalTokens += entry.totalTokens;
    }
  }
  
  const summaryLines = [
    `${COLORS.bold}Date:${COLORS.reset} ${todayStats.date}`,
    `${COLORS.bold}Requests:${COLORS.reset} ${todayStats.requests}`,
    `${COLORS.bold}Cost:${COLORS.reset} ${COLORS.green}${todayStats.satsCost.toFixed(3)} sats${COLORS.reset}`,
    `${COLORS.bold}Tokens:${COLORS.reset} ${formatNumber(todayStats.totalTokens)} (p: ${formatNumber(todayStats.promptTokens)} + c: ${formatNumber(todayStats.completionTokens)})`,
  ];
  
  let output = renderBox(summaryLines, width, "Today");
  output += "\n" + renderBox([], width, "Hourly Activity");
  
  // Hourly bar chart
  const hourLines: string[] = [];
  const maxHourCost = Math.max(
    ...Array.from(hourly.values()).map((h) => h.satsCost),
    1
  );
  
  for (let h = 0; h <= currentHour; h++) {
    const hStat = hourly.get(h);
    const reqs = hStat?.requests || 0;
    const cost = hStat?.satsCost || 0;
    const time = `${h.toString().padStart(2, "0")}:00`;
    const label = `${time} (${reqs} req, ${cost.toFixed(2)} sats)`;
    const barColor = h === currentHour ? COLORS.green : COLORS.cyan;
    hourLines.push(renderBarChart(label, cost, maxHourCost, width - 4, barColor));
  }
  
  if (hourLines.length > 0) {
    output += "\n" + renderBox(hourLines, width);
  } else {
    output += "\n" + renderBox(["No activity today yet"], width);
  }
  
  // Recent days
  const dayStats = getDayStats(stats.entries);
  const days = Array.from(dayStats.values()).slice(0, 7);
  
  if (days.length > 1) {
    const dayLines = days.slice(1).map((d) => {
      return `${d.date}: ${d.requests} req, ${d.satsCost.toFixed(2)} sats, ${formatNumber(d.totalTokens)} tokens`;
    });
    output += "\n" + renderBox(dayLines, width, "Recent Days");
  }
  
  return output;
}

function renderModels(stats: UsageStats, width: number): string {
  const modelStats = getModelStats(stats.entries);
  
  if (modelStats.length === 0) {
    return renderBox(["No model data available"], width, "Models");
  }
  
  const totalCost = stats.totalSatsCost;
  const maxCost = modelStats[0].satsCost;
  const maxTokens = Math.max(...modelStats.map((m) => m.totalTokens));
  
  const lines: string[] = [];
  
  for (const model of modelStats) {
    const color = MODEL_COLORS[model.modelId] || MODEL_COLORS.default;
    const pct = totalCost > 0 ? ((model.satsCost / totalCost) * 100).toFixed(1) : "0.0";
    
    lines.push(`${color}${COLORS.bold}${model.modelId}${COLORS.reset}`);
    lines.push(`  ${COLORS.dim}Cost:${COLORS.reset} ${model.satsCost.toFixed(3)} sats (${pct}%)`);
    lines.push(`  ${COLORS.dim}Requests:${COLORS.reset} ${model.requests}`);
    lines.push(`  ${COLORS.dim}Tokens:${COLORS.reset} ${formatNumber(model.totalTokens)}`);
    lines.push(`  ${COLORS.dim}Avg:${COLORS.reset} ${(model.satsCost / model.requests).toFixed(4)} sats/req`);
    lines.push(`  ${renderBarChart("  ", model.satsCost, maxCost, width - 4, color)}`);
    lines.push("");
  }
  
  return renderBox(lines, width, "Model Breakdown");
}

function renderProviders(stats: UsageStats, width: number): string {
  const providerStats = getProviderStats(stats.entries);
  
  if (providerStats.length === 0) {
    return renderBox(["No provider data available"], width, "Providers");
  }
  
  const lines: string[] = [];
  
  for (const provider of providerStats) {
    const shortUrl = provider.baseUrl.replace("https://", "").replace("http://", "");
    lines.push(`${COLORS.cyan}${COLORS.bold}${shortUrl}${COLORS.reset}`);
    lines.push(`  ${COLORS.dim}Requests:${COLORS.reset} ${provider.requests}`);
    lines.push(`  ${COLORS.dim}Cost:${COLORS.reset} ${provider.satsCost.toFixed(3)} sats`);
    lines.push(`  ${COLORS.dim}Tokens:${COLORS.reset} ${formatNumber(provider.totalTokens)}`);
    lines.push("");
  }
  
  return renderBox(lines, width, "Provider Breakdown");
}

function renderTokens(stats: UsageStats, width: number): string {
  const totals = getTotals(stats.entries);
  const modelStats = getModelStats(stats.entries);
  
  const summaryLines = [
    `${COLORS.bold}Total Prompt Tokens:${COLORS.reset} ${formatNumber(totals.promptTokens)}`,
    `${COLORS.bold}Total Completion Tokens:${COLORS.reset} ${formatNumber(totals.completionTokens)}`,
    `${COLORS.bold}Total Tokens:${COLORS.reset} ${formatNumber(totals.totalTokens)}`,
    `${COLORS.bold}Prompt/Completion Ratio:${COLORS.reset} ${(totals.promptTokens / Math.max(1, totals.completionTokens)).toFixed(2)}x`,
    `${COLORS.bold}Avg Tokens/Request:${COLORS.reset} ${(totals.totalTokens / Math.max(1, stats.totalEntries)).toFixed(0)}`,
  ];
  
  let output = renderBox(summaryLines, width, "Token Summary");
  
  // Token by model
  if (modelStats.length > 0) {
    const maxTokens = Math.max(...modelStats.map((m) => m.totalTokens));
    const tokenLines = modelStats.slice(0, 6).map((m) => {
      const color = MODEL_COLORS[m.modelId] || MODEL_COLORS.default;
      const promptPct = m.totalTokens > 0 
        ? ((m.promptTokens / m.totalTokens) * 100).toFixed(0) 
        : "0";
      return `${color}${m.modelId.padEnd(15)}${COLORS.reset} ${formatNumber(m.totalTokens).padStart(8)} tokens (${promptPct}% prompt)`;
    });
    output += "\n" + renderBox(tokenLines, width, "Tokens by Model");
  }
  
  // Size categories
  const sizeBuckets = {
    tiny: { min: 0, max: 1000, count: 0, cost: 0 },
    small: { min: 1000, max: 10000, count: 0, cost: 0 },
    medium: { min: 10000, max: 50000, count: 0, cost: 0 },
    large: { min: 50000, max: 100000, count: 0, cost: 0 },
    huge: { min: 100000, max: Infinity, count: 0, cost: 0 },
  };
  
  for (const entry of stats.entries) {
    for (const [name, bucket] of Object.entries(sizeBuckets)) {
      if (entry.totalTokens >= bucket.min && entry.totalTokens < bucket.max) {
        bucket.count++;
        bucket.cost += entry.satsCost;
        break;
      }
    }
  }
  
  const sizeLines = Object.entries(sizeBuckets).map(([name, bucket]) => {
    const label = `${name.padEnd(6)}: ${bucket.count.toString().padStart(4)} reqs, ${bucket.cost.toFixed(2)} sats`;
    return label;
  });
  
  output += "\n" + renderBox(sizeLines, width, "Request Size Distribution");
  
  return output;
}

function renderRecent(stats: UsageStats, width: number): string {
  const recentEntries = stats.entries.slice(0, 50);
  
  if (recentEntries.length === 0) {
    return renderBox(["No recent entries"], width, "Recent Requests");
  }
  
  const lines: string[] = [];
  
  // Header
  lines.push(
    `${COLORS.bold}${"TIME".padEnd(10)} ${"MODEL".padEnd(18)} ${"TOKENS".padEnd(10)} ${"COST".padEnd(12)} ${"PROVIDER".slice(0, Math.max(0, width - 60))}${COLORS.reset}`
  );
  lines.push(COLORS.dim + "─".repeat(width - 4) + COLORS.reset);
  
  for (const entry of recentEntries) {
    const time = formatTime(entry.timestamp).slice(0, 8);
    const model = entry.modelId.slice(0, 18).padEnd(18);
    const tokens = `${formatNumber(entry.totalTokens).padEnd(6)} (${formatNumber(entry.promptTokens)}+${formatNumber(entry.completionTokens)})`;
    const cost = `${entry.satsCost.toFixed(3).padEnd(10)} sats`;
    const provider = (entry.baseUrl || "unknown").replace("https://", "").replace("http://", "").slice(0, Math.max(0, width - 60));
    
    const color = MODEL_COLORS[entry.modelId] || MODEL_COLORS.default;
    lines.push(
      `${COLORS.dim}${time}${COLORS.reset} ${color}${model}${COLORS.reset} ${tokens.padEnd(10)} ${COLORS.green}${cost}${COLORS.reset} ${COLORS.dim}${provider}${COLORS.reset}`
    );
  }
  
  return renderBox(lines, width, `Recent Requests (${stats.entries.length} shown)`);
}

// ═══════════════════════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const width = getWidth();
  
  // Check if daemon is running
  const running = await isDaemonRunning();
  if (!running) {
    console.log(`${COLORS.red}Error: routstrd daemon is not running.${COLORS.reset}`);
    console.log(`Run ${COLORS.green}routstrd start${COLORS.reset} first.`);
    process.exit(1);
  }
  
  let currentTab: TabId = "overview";
  let stats: UsageStats | null = null;
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  let shouldUpdate = true;
  let autoRefresh = true;
  
  // Setup signal handlers
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");
  
  function cleanup() {
    if (refreshInterval) {
      clearInterval(refreshInterval);
    }
    process.stdout.write(clearScreen() + showCursor());
    process.exit(0);
  }
  
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  
  // Key handler
  process.stdin.on("data", (key: string) => {
    if (key === "q" || key === "Q" || key === "\u0003") {
      cleanup();
      return;
    }
    
    if (key === "r" || key === "R") {
      shouldUpdate = true;
      return;
    }
    
    if (key === "a" || key === "A") {
      autoRefresh = !autoRefresh;
      shouldUpdate = true;
      return;
    }
    
    // Tab switching with number keys
    const tab = TABS.find((t) => t.key === key);
    if (tab) {
      currentTab = tab.id;
      shouldUpdate = true;
    }
    
    // Arrow keys for future expansion
    if (key === "\x1b[A") {
      // Up arrow
    } else if (key === "\x1b[B") {
      // Down arrow
    }
  });
  
  // Render loop
  async function render() {
    if (shouldUpdate || autoRefresh) {
      stats = await fetchUsage(1000);
      shouldUpdate = false;
    }
    
    if (!stats) {
      process.stdout.write(
        clearScreen() + hideCursor() + moveCursor(1, 1) +
        `${COLORS.red}Error: Could not fetch usage data.${COLORS.reset}\n` +
        `Make sure routstrd is running.\n` +
        `\nPress Q to quit.`
      );
      return;
    }
    
    let content: string;
    
    switch (currentTab) {
      case "overview":
        content = renderOverview(stats, width);
        break;
      case "today":
        content = renderToday(stats, width);
        break;
      case "models":
        content = renderModels(stats, width);
        break;
      case "providers":
        content = renderProviders(stats, width);
        break;
      case "tokens":
        content = renderTokens(stats, width);
        break;
      case "recent":
        content = renderRecent(stats, width);
        break;
      default:
        content = "Unknown tab";
    }
    
    const output =
      clearScreen() +
      hideCursor() +
      moveCursor(1, 1) +
      renderHeader(currentTab, width) +
      renderTabs(currentTab, width) +
      renderSeparator(width) +
      content +
      "\n" +
      renderSeparator(width) +
      `${COLORS.dim}Press [Q] to quit, [R] to refresh, [A] to toggle auto-refresh${autoRefresh ? " (on)" : " (off)"}${COLORS.reset}`;
    
    process.stdout.write(output);
  }
  
  // Initial render
  await render();
  
  // Auto-refresh every 2 seconds
  refreshInterval = setInterval(async () => {
    if (autoRefresh) {
      shouldUpdate = true;
      await render();
    }
  }, 2000);
  
  // Render on demand
  process.stdin.on("data", () => {
    if (!autoRefresh) {
      render();
    }
  });
}

export async function runUsageTui(): Promise<void> {
  await main().catch((err) => {
    console.error("Error:", err);
    process.stdout.write(showCursor());
    process.exit(1);
  });
}
