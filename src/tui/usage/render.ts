import { CLIENT_COLORS, COLORS, MODEL_COLORS } from "./constants.ts";
import type { Tab } from "./types.ts";
import {
  formatNumber,
  formatTime,
  type ClientInfo,
} from "./data.ts";
import { vimState } from "./state.ts";
import { stripAnsi } from "./terminal.ts";
import type { BalanceInfo, StatusInfo } from "./data.ts";
import type { ErrorLogEntry, TabId, UsageStats } from "./types.ts";

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

export function renderHeader(activeTab: TabId, width: number, visibleTabs: Tab[]): string {
  const title = `${COLORS.bold}${COLORS.cyan}ROUTSTRD USAGE MONITOR${COLORS.reset}`;
  const vimIndicator = `${COLORS.yellow}[vim]${COLORS.reset}`;
  const maxKey = visibleTabs.length;
  const help = `${COLORS.dim}[Q] Quit  [↑↓] Scroll  [←→] Tabs  [1-${maxKey}] Tabs  [R] Refresh${COLORS.reset}`;
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

export function renderTabs(activeTab: TabId, visibleTabs: Tab[]): string {
  const tabStr = visibleTabs.map((tab) => tab.id === activeTab
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


export function renderOverview(stats: UsageStats, balance: BalanceInfo | null, status: StatusInfo | null, width: number): string {
  const totals = stats.summary.totals;
  const totalRequests = stats.totalEntries; // Use server's total count, not entries.length
  const totalVisibleCost = stats.totalSatsCost; // <-- Use server's total, not client-side sum of limited entries
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

  // Status and Balance boxes side by side
  const statusLines: string[] = [];
  if (status) {
    const daemonColor = status.daemon === "running" ? COLORS.green : COLORS.red;
    const walletColor = status.wallet === "connected" ? COLORS.green : COLORS.red;
    const modeColor = COLORS.cyan;
    statusLines.push(`${COLORS.bold}Daemon:${COLORS.reset} ${daemonColor}${status.daemon}${COLORS.reset}`);
    statusLines.push(`${COLORS.bold}Wallet:${COLORS.reset} ${walletColor}${status.wallet}${COLORS.reset}`);
    statusLines.push(`${COLORS.bold}Mode:${COLORS.reset} ${modeColor}${status.mode}${COLORS.reset}`);
    if (status.error) {
      statusLines.push(`${COLORS.bold}Error:${COLORS.reset} ${COLORS.red}${status.error}${COLORS.reset}`);
    }
  } else {
    statusLines.push(`${COLORS.dim}Status unavailable${COLORS.reset}`);
  }

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

    // Render status and balance boxes side by side
    const balanceBoxStr = renderBox(balanceLines, halfWidth1, "Balance");
    const statusBoxStr = renderBox(statusLines, halfWidth2, "System Status");
    const balanceBoxLines = balanceBoxStr.split("\n");
    const statusBoxLines = statusBoxStr.split("\n");
    const statusBalanceMaxLines = Math.max(balanceBoxLines.length, statusBoxLines.length);

    const statusBalanceLines: string[] = [];
    for (let i = 0; i < statusBalanceMaxLines; i++) {
      const b = balanceBoxLines[i] || " ".repeat(halfWidth1);
      const s = statusBoxLines[i] || " ".repeat(halfWidth2);
      statusBalanceLines.push(b + s);
    }
    output = statusBalanceLines.join("\n") + "\n" + output;
  } else if (balance && balance.keys.length === 0) {
    // Only balance is empty, show status next to empty balance box
    const balanceLines: string[] = [
      `${COLORS.bold}Total Balance:${COLORS.reset} ${COLORS.red}0 sat${COLORS.reset}`,
      `${COLORS.dim}No funds available${COLORS.reset}`,
    ];
    const balanceBoxStr = renderBox(balanceLines, halfWidth1, "Balance");
    const statusBoxStr = renderBox(statusLines, halfWidth2, "System Status");
    const balanceBoxLines = balanceBoxStr.split("\n");
    const statusBoxLines = statusBoxStr.split("\n");
    const statusBalanceMaxLines = Math.max(balanceBoxLines.length, statusBoxLines.length);

    const statusBalanceLines: string[] = [];
    for (let i = 0; i < statusBalanceMaxLines; i++) {
      const b = balanceBoxLines[i] || " ".repeat(halfWidth1);
      const s = statusBoxLines[i] || " ".repeat(halfWidth2);
      statusBalanceLines.push(b + s);
    }
    output = statusBalanceLines.join("\n") + "\n" + output;
  } else {
    // No balance data, just show status box full width
    output = renderBox(statusLines, width, "System Status") + "\n" + output;
  }

  const modelStats = stats.summary.models;
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

  const clientStats = stats.summary.clients;
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
  const currentHour = new Date().getHours();
  // Build today's date string from LOCAL date components so it matches the
  // server's tz-bucketed day keys (which use the client's tzOffsetMinutes).
  const _now = new Date();
  const todayDateStr = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, "0")}-${String(_now.getDate()).padStart(2, "0")}`;

  let todayStats: { date: string; requests: number; satsCost: number; promptTokens: number; completionTokens: number; totalTokens: number } = {
    date: todayDateStr,
    requests: 0,
    satsCost: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  let recentDays: Array<{ date: string; requests: number; satsCost: number; totalTokens: number; promptTokens: number; completionTokens: number }> = [];
  let hourlyMap: Map<number, { requests: number; satsCost: number }> = new Map();

  if (stats.summary) {
    // Use server-aggregated data
    const { days, hoursToday } = stats.summary;
    // days[0] is most-recent-first; check if it's today
    const todayDayStat = days[0]?.date === todayDateStr ? days[0] : undefined;
    if (todayDayStat) {
      todayStats = { date: todayDayStat.date, requests: todayDayStat.requests, satsCost: todayDayStat.satsCost, promptTokens: todayDayStat.promptTokens, completionTokens: todayDayStat.completionTokens, totalTokens: todayDayStat.totalTokens };
    }
    // Exclude today by date (it has its own box) rather than by position —
    // days[0] is only today when there was activity today.
    recentDays = days.filter((d) => d.date !== todayDateStr).slice(0, 6);
    hourlyMap = new Map(hoursToday.map((h) => [h.hour, { requests: h.requests, satsCost: h.satsCost }]));
  }

  const summaryLines = [
    `${COLORS.bold}Date:${COLORS.reset} ${todayStats.date}`,
    `${COLORS.bold}Requests:${COLORS.reset} ${formatReqs(todayStats.requests)}`,
    `${COLORS.bold}Cost:${COLORS.reset} ${COLORS.green}${formatCost(todayStats.satsCost)} sats${COLORS.reset}`,
    `${COLORS.bold}Tokens:${COLORS.reset} ${formatNumber(todayStats.totalTokens)} (p: ${formatNumber(todayStats.promptTokens)} + c: ${formatNumber(todayStats.completionTokens)})`,
  ];

  let output = renderBox(summaryLines, width, "Today");

  if (recentDays.length > 0) {
    const dayLines = recentDays.map((d) => `${d.date}: ${formatReqs(d.requests)} req, ${formatCost(d.satsCost)} sats, ${formatNumber(d.totalTokens)} tokens`);
    output += "\n" + renderBox(dayLines, width, "Recent Days");
  }

  const hourLines: string[] = [];
  const maxHourCost = Math.max(...Array.from(hourlyMap.values()).map((h) => h.satsCost), 1);
  const totalTodayCost = Math.max(todayStats.satsCost, 1);
  const hourLabels: string[] = [];
  for (let h = currentHour; h >= 0; h--) {
    const hStat = hourlyMap.get(h);
    const reqs = hStat?.requests || 0;
    const cost = hStat?.satsCost || 0;
    hourLabels.push(`${h.toString().padStart(2, "0")}:00 (${formatReqs(reqs)} req, ${formatCost(cost)} sats) `);
  }
  const maxHourLabel = Math.max(...hourLabels.map((l) => l.length));
  startBarSection("hourly", maxHourLabel);
  for (let i = currentHour; i >= 0; i--) {
    const hStat = hourlyMap.get(i);
    const reqs = hStat?.requests || 0;
    const cost = hStat?.satsCost || 0;
    hourLines.push(renderBarChart(
      hourLabels[currentHour - i]!,
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

  return output;
}

export function renderModels(stats: UsageStats, width: number): string {
  const modelStats = stats.summary.models;
  if (modelStats.length === 0) return renderBox(["No model data available"], width, "Models");

  // Use totalSatsCost (all-time) for percentage calculations to match header
  const totalCost = stats.totalSatsCost;
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
  const providerStats = stats.summary.providers;
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
  const totals = stats.summary.totals;
  const modelStats = stats.summary.models;
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

  const sizeBuckets = stats.summary.sizeBuckets;

  const sizeLines = Object.entries(sizeBuckets).map(([name, bucket]) => `${name.padEnd(6)}: ${formatReqs(bucket.count).padStart(5)} reqs, ${formatCost(bucket.cost)} sats`);
  output += "\n" + renderBox(sizeLines, width, "Request Size Distribution");
  return output;
}

export function renderClients(stats: UsageStats, width: number): string {
  const clientStats = stats.summary.clients;
  if (clientStats.length === 0) return renderBox(["No client data available (API key auth not used)"], width, "Client Breakdown");

  // Use totalSatsCost (all-time) for percentage calculations to match header
  const totalCost = stats.totalSatsCost;
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
    for (const topClient of stats.summary.clients.filter((c) => c.client !== "unknown").slice(0, 3)) {
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

export function renderNpubs(stats: UsageStats, clients: ClientInfo[], width: number): string {
  const npubStats = stats.summary.npubs;
  if (npubStats.length === 0) return renderBox(["No npub data available"], width, "Npub Breakdown");

  const totalCost = stats.totalSatsCost;
  const maxCost = npubStats[0]!.satsCost;
  const lines: string[] = [];

  const col1 = 24; // Npub (truncated)
  const col2 = 12; // Requests
  const col3 = 24; // Cost
  const col4 = 12; // Tokens

  const hNpub = "Npub".padEnd(col1);
  const hReqs = "Requests".padEnd(col2);
  const hCost = "Cost".padEnd(col3);
  const hTok = "Tokens".padEnd(col4);
  lines.push(`${COLORS.bold}${hNpub}${hReqs}${hCost}${hTok}Avg Cost${COLORS.reset}`);
  lines.push(COLORS.dim + "─".repeat(Math.max(0, width - 4)) + COLORS.reset);

  startBarSection("npub-detail", col1);
  for (const npub of npubStats) {
    const pct = totalCost > 0 ? ((npub.satsCost / totalCost) * 100).toFixed(1) : "0.0";
    const avgCostFormatted = formatCost(npub.requests > 0 ? npub.satsCost / npub.requests : 0);
    const shortNpub = truncateNpub(npub.npub);

    const dNpub = shortNpub.padEnd(col1);
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
    // Full npub on its own line for copy-ability
    lines.push(`  ${COLORS.dim}${npub.npub}${COLORS.reset}`);
    lines.push(`  ${renderBarChart("", npub.satsCost, maxCost, width - 6, COLORS.magenta, Number(pct), "npub-detail")}`);
    lines.push("");
  }
  endBarSection("npub-detail");

  let output = renderBox(lines, width, "Npub Breakdown");
  const npubModelLines: string[] = [];

  if (stats.summary) {
    // Use pre-aggregated topModels from summary
    for (const topNpub of stats.summary.npubs.slice(0, 5)) {
      if (topNpub.topModels.length === 0) continue;
      npubModelLines.push(`${COLORS.bold}${truncateNpub(topNpub.npub)}${COLORS.reset} (${formatReqs(topNpub.requests)} reqs, ${formatCost(topNpub.satsCost)} sats)`);
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

export function renderRecent(stats: UsageStats, width: number): string {
  const recentEntries = stats.entries.slice(0, 50);
  if (recentEntries.length === 0) return renderBox(["No recent entries"], width, "Recent Requests");

  const clientCol = 14;
  const tokensCol = 18;
  const costCol = 18;
  const providerCol = Math.max(16, width - 4 - 10 - 18 - tokensCol - costCol - clientCol - 5);
  const msatsToSats = (msats?: number) => typeof msats === "number" ? msats / 1000 : 0;
  const lines: string[] = [];
  lines.push(`${COLORS.bold}${"TIME".padEnd(10)} ${"MODEL".padEnd(18)} ${"I/CR/CW/O".padEnd(tokensCol)} ${"I/O/T in sats".padEnd(costCol)} ${"BASE:PROVIDER".padEnd(providerCol)} ${"CLIENT".slice(0, clientCol)}${COLORS.reset}`);
  lines.push(COLORS.dim + "─".repeat(width - 4) + COLORS.reset);

  for (const entry of recentEntries) {
    const time = formatTime(entry.timestamp).slice(0, 8);
    const model = entry.modelId.slice(0, 18).padEnd(18);
    const tokens = [
      entry.promptTokens,
      entry.cacheReadInputTokens || 0,
      entry.cacheCreationInputTokens || 0,
      entry.completionTokens,
    ].map(formatNumber).join("/");
    const totalSats = typeof entry.totalMsats === "number" ? entry.totalMsats / 1000 : entry.satsCost;
    const cost = [
      formatCost(msatsToSats(entry.inputMsats)),
      formatCost(msatsToSats(entry.outputMsats)),
      formatCost(totalSats),
    ].join("/");
    const baseUrl = (entry.baseUrl || "unknown").replace("https://", "").replace("http://", "");
    const provider = `${baseUrl}:${entry.provider || "unknown"}`.slice(0, providerCol).padEnd(providerCol);
    const clientName = (entry.client || "unknown").slice(0, clientCol - 1);
    const clientColor = CLIENT_COLORS[entry.client || "unknown"] || CLIENT_COLORS.default || COLORS.white;
    const modelColor = MODEL_COLORS[entry.modelId] || MODEL_COLORS.default;
    lines.push(`${COLORS.dim}${time}${COLORS.reset} ${modelColor}${model}${COLORS.reset} ${tokens.padEnd(tokensCol)} ${COLORS.green}${cost.padEnd(costCol)}${COLORS.reset} ${COLORS.dim}${provider}${COLORS.reset} ${clientColor}${clientName}${COLORS.reset}`);
  }

  return renderBox(lines, width, `Recent Requests (${stats.entries.length} shown)`);
}

export function renderErrors(errors: ErrorLogEntry[], width: number, selectedIndex = 0): string {
  if (errors.length === 0) return renderBox(["No recent errors"], width, "Recent Errors");

  const innerWidth = Math.max(1, width - 4);
  const timeCol = innerWidth >= 30 ? 19 : 8;
  const messageCol = Math.max(1, innerWidth - timeCol - 1);
  const lines = [
    `${COLORS.bold}${"TIME".padEnd(timeCol)} ${"ERROR".slice(0, messageCol)}${COLORS.reset}`,
    COLORS.dim + "─".repeat(innerWidth) + COLORS.reset,
  ];

  for (const [errorIndex, error] of errors.entries()) {
    const fullTimestamp = error.timestamp.replace("T", " ").replace("Z", "");
    const timestamp = timeCol === 8 ? fullTimestamp.slice(11, 19) : fullTimestamp.slice(0, timeCol);
    let firstLine = true;

    for (const rawLine of error.message.split("\n")) {
      const message = rawLine.replace(/\t/g, "  ").replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
      const chunks = message.match(new RegExp(`.{1,${messageCol}}`, "g")) || [""];
      for (const chunk of chunks) {
        const time = firstLine ? timestamp : "";
        const selected = errorIndex === selectedIndex;
        const row = selected
          ? `${COLORS.bgBlue}${COLORS.bright}${time.padEnd(timeCol)} ${chunk.padEnd(messageCol)}${COLORS.reset}`
          : `${COLORS.dim}${time.padEnd(timeCol)}${COLORS.reset} ${COLORS.red}${chunk}${COLORS.reset}`;
        lines.push(row);
        firstLine = false;
      }
    }
  }

  const title = width < 30 ? "Recent Errors" : `Recent Errors (${errors.length} shown)`;
  return renderBox(lines, width, title);
}

export function renderTabContent(activeTab: TabId, stats: UsageStats, balance: BalanceInfo | null, status: StatusInfo | null, width: number, clients: ClientInfo[] = [], errors: ErrorLogEntry[] = [], selectedErrorIndex = 0): string {
  switch (activeTab) {
    case "overview": return renderOverview(stats, balance, status, width);
    case "today": return renderToday(stats, width);
    case "models": return renderModels(stats, width);
    case "providers": return renderProviders(stats, width);
    case "tokens": return renderTokens(stats, width);
    case "clients": return renderClients(stats, width);
    case "npubs": return renderNpubs(stats, clients, width);
    case "recent": return renderRecent(stats, width);
    case "errors": return renderErrors(errors, width, selectedErrorIndex);
    default: return "Unknown tab";
  }
}
