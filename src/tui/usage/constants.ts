import type { Tab } from "./types.ts";

export const TABS: Tab[] = [
  { id: "overview", name: "Overview", key: "1" },
  { id: "today", name: "Today", key: "2" },
  { id: "models", name: "Models", key: "3" },
  { id: "providers", name: "Providers", key: "4" },
  { id: "tokens", name: "Tokens", key: "5" },
  { id: "clients", name: "Clients", key: "6" },
  { id: "recent", name: "Recent", key: "7" },
];

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
