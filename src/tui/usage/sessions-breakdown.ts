import { COLORS } from "./constants.ts";
import { renderBox } from "./render.ts";
import { sessionTotals, type SessionTurn } from "./sessions-data.ts";
import { elideNodeLabel, splitNodeUrl, truncateMiddle } from "../../utils/model-providers.ts";

/** Node-only equivalent of Recent's BASE:PROVIDER cell: elide the opaque label first. */
function nodeCell(node: string, width: number): string {
  const url = node.replace(/^https?:\/\//, "");
  const { label, tail } = splitNodeUrl(url);
  const budget = width - tail.length;
  return budget >= 4 ? elideNodeLabel(label, Math.min(15, budget)) + tail : truncateMiddle(url, width, 0.5);
}
function cell(value: string, width: number, numeric = false): string {
  // Keep an explicit unknown/partial suffix even when a numeric value is clipped.
  const suffix = value.endsWith("+?") ? "+?" : value === "—" ? "—" : "";
  const clipped = value.length <= width ? value : numeric && suffix
    ? truncateMiddle(value.slice(0, -suffix.length), Math.max(1, width - suffix.length)) + suffix
    : truncateMiddle(value, width, 0.5);
  return numeric ? clipped.padStart(width) : clipped.padEnd(width);
}

export function renderSessionBreakdown(turns: SessionTurn[], width: number): string {
  // Tuple keys avoid accidentally merging values containing the separator text.
  const groups = new Map<string, { node: string; provider: string; turns: SessionTurn[] }>();
  for (const turn of turns) {
    const key = JSON.stringify([turn.node, turn.provider]);
    const group = groups.get(key) ?? { node: turn.node, provider: turn.provider, turns: [] };
    group.turns.push(turn); groups.set(key, group);
  }
  const rows = [...groups.values()].map(g => {
    const t = sessionTotals(g.turns);
    return [g.node, g.provider, String(g.turns.length), t.sats === null ? "—" : t.sats.toFixed(2) + (t.priced < g.turns.length ? "+?" : ""), t.eligible ? String(t.misses) : "—", t.eligible ? t.missed.toLocaleString("en-US") : "—"];
  });
  const compact = width < 70;
  const headers = compact ? ["Node", "Provider", "Turns", "sats", "M*", "Tokens*"] : ["Node", "Provider", "Turns", "sats", "Misses*", "Missed tokens*"];
  const widths = compact ? [4, 4, 5, 5, 2, 7] : [12, 14, 5, 8, 7, 14];
  const available = Math.max(0, width - 4 - 5); // box padding and column gaps
  let slack = available - widths.reduce((s, n) => s + n, 0);
  // Give additional room first to numeric values, then identities, without expanding unboundedly.
  for (const i of [2, 3, 4, 5, 1, 0]) {
    const desired = Math.min(i < 2 ? 48 : 24, Math.max(headers[i]!.length, ...rows.map(r => r[i]!.length)));
    const extra = Math.max(0, Math.min(slack, desired - widths[i]!));
    widths[i]! += extra; slack -= extra;
  }
  // Tiny terminals still get bounded clipping from the same box renderer as Recent.
  const header = headers.map((h, i) => cell(h, widths[i]!, i >= 2)).join(" ");
  const lines = [`${COLORS.bold}${header}${COLORS.reset}`, `${COLORS.dim}${"─".repeat(Math.max(0, width - 4))}${COLORS.reset}`];
  for (const row of rows) {
    lines.push(row.map((value, i) => {
      const text = i === 0 ? nodeCell(value, widths[0]!) : value;
      const color = i === 3 ? COLORS.green : i < 2 ? COLORS.dim : "";
      return color + cell(text, widths[i]!, i >= 2) + (color ? COLORS.reset : "");
    }).join(" "));
  }
  if (!rows.length) lines.push("No session requests");
  if (rows.some(r => r[3]!.endsWith("+?"))) lines.push(`${COLORS.dim}+? = additional unknown spend${COLORS.reset}`);
  return renderBox(lines, width, "NODE × PROVIDER");
}
