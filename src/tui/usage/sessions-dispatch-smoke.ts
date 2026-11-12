/** Isolated full-app dispatch regression harness, run by sessions.test.ts. */
import { mock } from "bun:test";
import { vimState } from "./state.ts";
const data = await import("./data.ts");
mock.module("./data.ts", () => ({ ...data, isDaemonRunning: async () => true,
 fetchUsageSummary: async () => null, fetchBalance: async () => null,
 fetchStatus: async () => null, fetchClients: async () => [], fetchMonthlyQuota: async () => null,
}));
const { runUsageTui } = await import("./app.ts");
Object.defineProperty(process.stdout, "isTTY", { value: true });
Object.defineProperty(process.stdin, "isTTY", { value: true });
let output = "";
process.stdout.write = ((text: string | Uint8Array) => { output = String(text); return true; }) as typeof process.stdout.write;
process.stdin.setRawMode = () => process.stdin;
process.stdin.resume = () => process.stdin;
process.stdin.pause = () => process.stdin;
let receive: (key: string) => void = () => {};
process.stdin.on = ((event: string, handler: (key: string) => void) => { if (event === "data") receive = handler; return process.stdin; }) as typeof process.stdin.on;
(globalThis as any).Worker = class {
 onmessage: any; onerror: any;
 postMessage() { queueMicrotask(() => this.onmessage({ data: { sessions: [{ id: "s", path: "/fixture", cwd: "/fixture", title: "fixture", active: 0, turns: Array.from({ length: 30 }, (_, i) => ({ timestamp: "2026-01-01T00:00:00Z", model: `model-${i}`, prompt: 7000, output: 20, cacheRead: 5000, missed: 0, eligible: true, node: "Unknown", provider: "Unknown", sats: null, match: "missing" })), warnings: [] }], more: false } })); }
 terminate() {}
};
let quit = false;
process.exit = (() => { quit = true; throw new Error("quit"); }) as typeof process.exit;
await runUsageTui();
receive("6"); // Sessions without Npubs
await Bun.sleep(0);
for (const key of ["/", "?"]) {
 receive("\r");
 if (!output.includes("Title:") || !output.includes("Session: s")) throw Error("detail did not open");
 receive("\x06"); // existing page-down reaches the shared request table
 if (vimState.scrollPos === 0) throw Error("request page scroll failed");
 receive("\x1b[H");
 if (vimState.scrollPos !== 0) throw Error("request scroll-to-top failed");
 receive(key); receive("\x1b");
 if (vimState.isSearching) throw Error("Sessions leaked global search");
 receive("7");
 if (!output.includes("Could not fetch usage data")) throw Error("tab switch failed");
 receive("6");
 if (!output.includes("First user message") && !output.includes("misses*")) throw Error("Sessions tab did not return");
 receive("r");
}
try { receive("q"); } catch (error) { if (!quit) throw error; }
if (!quit) throw Error("quit key captured by search");
console.error("full dispatch OK");
// App schedules update timers; exit without firing them.
process.reallyExit(0);
