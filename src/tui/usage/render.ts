import { CLIENT_COLORS, COLORS, MODEL_COLORS, TABS } from "./constants.ts";
import {
  formatDate,
  formatNumber,
  formatTime,
  getClientStats,
  getDayStats,
  getHourlyToday,
  getModelStats,
  getProviderStats,
  getTodayStart,
  getTotals,
} from "./data.ts";
import { vimState } from "./state.ts";
import { stripAnsi } from "./terminal.ts";
import type { BalanceInfo } from "./data.ts";
import type { TabId, UsageStats } from "./types.ts";

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

export function renderHeader(activeTab: TabId, width: number): string {
  const title = `${COLORS.bold}${COLORS.cyan}ROUTSTRD USAGE MONITOR${COLORS.reset}`;
  const vimIndicator = `${COLORS.yellow}[vim]${COLORS.reset}`;
  const help = `${COLORS.dim}[Q] Quit  [↑↓] Scroll  [←→] Tabs  [1-7] Tabs  [R] Refresh${COLORS.reset}`;
  const fill = width - title.length - help.length - vimIndicator.length - 6;
  return `${title}${vimIndicator}${" ".repeat(Math.max(1, fill))}${help}\n`;
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

export function renderTabs(activeTab: TabId): string {
  const tabStr = TABS.map((tab) => tab.id === activeTab
    ? `${COLORS.bgBlue} ${tab.key}:${tab.name} ${COLORS.reset}`
    : `${COLORS.dim}[${tab.key}]${COLORS.reset} ${tab.name}`).join("  ");
  return `${" ".repeat(2)}${tabStr}\n`;
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
  
  for (const line of lines) {
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


export function renderOverview(stats: UsageStats, balance: BalanceInfo | null, width: number): string {
  const totals = getTotals(stats.entries);
  const entryCount = stats.entries.length;
  const totalVisibleCost = totals.satsCost;
  const avgCost = entryCount > 0 ? totalVisibleCost / entryCount : 0;
  const avgTokens = entryCount > 0 ? totals.totalTokens / entryCount : 0;

  const leftBox = [
    `${COLORS.bold}Total Spent:${COLORS.reset} ${COLORS.green}${formatCost(totalVisibleCost)} sats${COLORS.reset}`,
    `${COLORS.bold}Total Requests:${COLORS.reset} ${formatReqs(entryCount)}`,
    `${COLORS.bold}Avg Cost/Req:${COLORS.reset} ${formatCost(avgCost)} sats`,
  ];

  const rightBox = [
    `${COLORS.bold}Total Tokens:${COLORS.reset} ${formatNumber(totals.totalTokens)}`,
    `${COLORS.bold}Avg Tokens/Req:${COLORS.reset} ${formatNumber(Math.round(avgTokens))}`,
    `${COLORS.bold}Prompt/Comp:${COLORS.reset} ${(totals.promptTokens / Math.max(1, totals.completionTokens)).toFixed(2)}x`,
  ];

  const halfWidth1 = Math.floor(width / 2);
  const halfWidth2 = width - halfWidth1;

  const leftBoxStr = renderBox(leftBox, halfWidth1, "Stats of Sats");
  const rightBoxStr = renderBox(rightBox, halfWidth2, "Token Stats");

  const leftLines = leftBoxStr.split("\n");
  const rightLines = rightBoxStr.split("\n");
  const maxLines = Math.max(leftLines.length, rightLines.length);

  const combinedLines: string[] = [];
  for (let i = 0; i < maxLines; i++) {
    const l = leftLines[i] || " ".repeat(halfWidth1);
    const r = rightLines[i] || " ".repeat(halfWidth2);
    combinedLines.push(l + r);
  }

  let output = combinedLines.join("\n");

  // Display all balances (wallet, cached tokens, API keys) if available
  if (balance && balance.keys.length > 0) {
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

    output = renderBox(balanceLines, width, "Balance") + "\n" + output;
  } else if (balance && balance.keys.length === 0) {
    const balanceLines: string[] = [
      `${COLORS.bold}Total Balance:${COLORS.reset} ${COLORS.red}0 sat${COLORS.reset}`,
      `${COLORS.dim}No funds available${COLORS.reset}`,
    ];
    output = renderBox(balanceLines, width, "Balance") + "\n" + output;
  }

  const modelStats = getModelStats(stats.entries);
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
    output += "\n" + renderBox(modelLines, width, "Top Models by Cost");
  }

  const clientStats = getClientStats(stats.entries);
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
    output += "\n" + renderBox(clientLines, width, "Usage by Client");
  }

  return output;
}

export function renderToday(stats: UsageStats, width: number): string {
  const hourly = getHourlyToday(stats.entries);
  const todayStart = getTodayStart();
  const currentHour = new Date().getHours();
  const todayStats = { date: formatDate(Date.now()), requests: 0, satsCost: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

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
    `${COLORS.bold}Requests:${COLORS.reset} ${formatReqs(todayStats.requests)}`,
    `${COLORS.bold}Cost:${COLORS.reset} ${COLORS.green}${formatCost(todayStats.satsCost)} sats${COLORS.reset}`,
    `${COLORS.bold}Tokens:${COLORS.reset} ${formatNumber(todayStats.totalTokens)} (p: ${formatNumber(todayStats.promptTokens)} + c: ${formatNumber(todayStats.completionTokens)})`,
  ];

  let output = renderBox(summaryLines, width, "Today");

  const hourLines: string[] = [];
  const maxHourCost = Math.max(...Array.from(hourly.values()).map((h) => h.satsCost), 1);
  const totalTodayCost = Math.max(todayStats.satsCost, 1);
  const hourLabels: string[] = [];
  for (let h = 0; h <= currentHour; h++) {
    const hStat = hourly.get(h);
    const reqs = hStat?.requests || 0;
    const cost = hStat?.satsCost || 0;
    hourLabels.push(`${h.toString().padStart(2, "0")}:00 (${formatReqs(reqs)} req, ${formatCost(cost)} sats) `);
  }
  const maxHourLabel = Math.max(...hourLabels.map((l) => l.length));
  startBarSection("hourly", maxHourLabel);
  for (let i = 0; i <= currentHour; i++) {
    const hStat = hourly.get(i);
    const reqs = hStat?.requests || 0;
    const cost = hStat?.satsCost || 0;
    hourLines.push(renderBarChart(
      hourLabels[i]!,
      cost,
      maxHourCost,
      width - 4,
      i === currentHour ? COLORS.green : COLORS.cyan,
      (cost / totalTodayCost) * 100,
      "hourly",
    ));
  }
  endBarSection("hourly");

  output += "\n" + renderBox(hourLines.length > 0 ? hourLines : ["No activity today yet"], width, "Hourly Activity");

  const days = Array.from(getDayStats(stats.entries).values()).slice(0, 7);
  if (days.length > 1) {
    const dayLines = days.slice(1).map((d) => `${d.date}: ${formatReqs(d.requests)} req, ${formatCost(d.satsCost)} sats, ${formatNumber(d.totalTokens)} tokens`);
    output += "\n" + renderBox(dayLines, width, "Recent Days");
  }

  return output;
}

export function renderModels(stats: UsageStats, width: number): string {
  const modelStats = getModelStats(stats.entries);
  if (modelStats.length === 0) return renderBox(["No model data available"], width, "Models");

  const totalCost = getTotals(stats.entries).satsCost;
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
  const providerStats = getProviderStats(stats.entries);
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

  if (modelStats.length > 0) {
    const tokenLines = modelStats.slice(0, 6).map((m) => {
      const color = MODEL_COLORS[m.modelId] || MODEL_COLORS.default;
      const promptPct = m.totalTokens > 0 ? ((m.promptTokens / m.totalTokens) * 100).toFixed(0) : "0";
      return `${color}${m.modelId.padEnd(15)}${COLORS.reset} ${formatNumber(m.totalTokens).padStart(8)} tokens (${promptPct}% prompt)`;
    });
    output += "\n" + renderBox(tokenLines, width, "Tokens by Model");
  }

  const sizeBuckets = {
    tiny: { min: 0, max: 1000, count: 0, cost: 0 },
    small: { min: 1000, max: 10000, count: 0, cost: 0 },
    medium: { min: 10000, max: 50000, count: 0, cost: 0 },
    large: { min: 50000, max: 100000, count: 0, cost: 0 },
    huge: { min: 100000, max: Infinity, count: 0, cost: 0 },
  };

  for (const entry of stats.entries) {
    for (const bucket of Object.values(sizeBuckets)) {
      if (entry.totalTokens >= bucket.min && entry.totalTokens < bucket.max) {
        bucket.count++;
        bucket.cost += entry.satsCost;
        break;
      }
    }
  }

  const sizeLines = Object.entries(sizeBuckets).map(([name, bucket]) => `${name.padEnd(6)}: ${formatReqs(bucket.count).padStart(5)} reqs, ${formatCost(bucket.cost)} sats`);
  output += "\n" + renderBox(sizeLines, width, "Request Size Distribution");
  return output;
}

export function renderClients(stats: UsageStats, width: number): string {
  const clientStats = getClientStats(stats.entries);
  if (clientStats.length === 0) return renderBox(["No client data available (API key auth not used)"], width, "Client Breakdown");

  const totalCost = getTotals(stats.entries).satsCost;
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
  const clientModelMap = new Map<string, Map<string, { requests: number; satsCost: number; tokens: number }>>();

  for (const entry of stats.entries) {
    const client = entry.client || "unknown";
    const model = entry.modelId;
    if (!clientModelMap.has(client)) clientModelMap.set(client, new Map());
    const modelMap = clientModelMap.get(client)!;
    const existing = modelMap.get(model) || { requests: 0, satsCost: 0, tokens: 0 };
    modelMap.set(model, {
      requests: existing.requests + 1,
      satsCost: existing.satsCost + entry.satsCost,
      tokens: existing.tokens + entry.totalTokens,
    });
  }

  const clientModelLines: string[] = [];
  for (const topClient of clientStats.slice(0, 3)) {
    const modelMap = clientModelMap.get(topClient.client);
    if (!modelMap) continue;
    const models = Array.from(modelMap.entries()).sort((a, b) => b[1].satsCost - a[1].satsCost).slice(0, 5);
    clientModelLines.push(`${COLORS.bold}${topClient.client}${COLORS.reset} (${formatReqs(topClient.requests)} reqs, ${formatCost(topClient.satsCost)} sats)`);
    for (const [model, data] of models) {
      clientModelLines.push(`  ${(MODEL_COLORS[model] || MODEL_COLORS.default)}${model.padEnd(18)}${COLORS.reset} ${formatNumber(data.tokens).padEnd(8)} tokens  ${formatCost(data.satsCost)} sats`);
    }
    clientModelLines.push("");
  }

  if (clientModelLines.length > 0) {
    output += "\n" + renderBox(clientModelLines, width, "Top Models per Client");
  }
  return output;
}

export function renderRecent(stats: UsageStats, width: number): string {
  const recentEntries = stats.entries.slice(0, 50);
  if (recentEntries.length === 0) return renderBox(["No recent entries"], width, "Recent Requests");

  const lines: string[] = [];
  lines.push(`${COLORS.bold}${"TIME".padEnd(10)} ${"MODEL".padEnd(18)} ${"TOKENS".padEnd(10)} ${"COST".padEnd(12)} ${"PROVIDER".slice(0, Math.max(0, width - 60))}${COLORS.reset}`);
  lines.push(COLORS.dim + "─".repeat(width - 4) + COLORS.reset);

  for (const entry of recentEntries) {
    const time = formatTime(entry.timestamp).slice(0, 8);
    const model = entry.modelId.slice(0, 18).padEnd(18);
    const tokens = `${formatNumber(entry.totalTokens).padEnd(6)} (${formatNumber(entry.promptTokens)}+${formatNumber(entry.completionTokens)})`;
    const cost = `${formatCost(entry.satsCost).padEnd(8)} sats`;
    const provider = (entry.baseUrl || "unknown").replace("https://", "").replace("http://", "").slice(0, Math.max(0, width - 60));
    const color = MODEL_COLORS[entry.modelId] || MODEL_COLORS.default;
    lines.push(`${COLORS.dim}${time}${COLORS.reset} ${color}${model}${COLORS.reset} ${tokens.padEnd(10)} ${COLORS.green}${cost}${COLORS.reset} ${COLORS.dim}${provider}${COLORS.reset}`);
  }

  return renderBox(lines, width, `Recent Requests (${stats.entries.length} shown)`);
}

export function renderTabContent(activeTab: TabId, stats: UsageStats, balance: BalanceInfo | null, width: number): string {
  switch (activeTab) {
    case "overview": return renderOverview(stats, balance, width);
    case "today": return renderToday(stats, width);
    case "models": return renderModels(stats, width);
    case "providers": return renderProviders(stats, width);
    case "tokens": return renderTokens(stats, width);
    case "clients": return renderClients(stats, width);
    case "recent": return renderRecent(stats, width);
    default: return "Unknown tab";
  }
}
