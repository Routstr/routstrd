/** Isolated async integration: Recent works without opening Sessions. */
import { mock } from "bun:test";
const data = await import("./data.ts");
let daemonReads = 0;
const totals = { requests: 1, satsCost: 1, cost: 0, promptTokens: 8000, completionTokens: 1, totalTokens: 8001 };
const aggregates = { totals, models: [], providers: [], clients: [], npubs: [], sizeBuckets: {} };
const entry = { id: "r", requestId: "lifecycle", upstreamResponseId: "response", timestamp: Date.now(), modelId: "model", baseUrl: "node", promptTokens: 8000, completionTokens: 1, totalTokens: 8001, satsCost: 1, cost: 0 };
mock.module("../../utils/daemon-client.ts", () => ({ loadConfig: async () => ({}) }));
mock.module("./data.ts", () => ({ ...data, isDaemonRunning: async () => true,
 fetchUsageSummary: async () => { daemonReads++; return { entries: [entry], summary: aggregates, window: { ...aggregates, window: "all", timeline: { bucket: "day", points: [] } } }; },
 fetchBalance: async () => null, fetchStatus: async () => null, fetchClients: async () => [], fetchMonthlyQuota: async () => null,
}));
mock.module("./update-poller.ts", () => ({ createUpdatePoller: () => async () => {} }));
const { runUsageTui } = await import("./app.ts");
Object.defineProperty(process.stdout, "isTTY", { value: true }); Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "columns", { value: 160 }); Object.defineProperty(process.stdout, "rows", { value: 40 });
let output = ""; process.stdout.write = ((s: any) => { output = String(s); return true; }) as any;
process.stdin.setRawMode = () => process.stdin; process.stdin.resume = () => process.stdin; process.stdin.pause = () => process.stdin;
let receive: (s: string) => void = () => {};
process.stdin.on = ((e: string, fn: any) => { if (e === "data") receive = fn; return process.stdin; }) as any;
let worker: any, requests = 0;
(globalThis as any).Worker = class { onmessage: any; onerror: any; constructor() { worker = this; } postMessage() { requests++; } terminate() {} };
await runUsageTui();
if (requests !== 1) throw Error("canonical load did not start independently of Sessions");
receive("7");
if (!output.includes("Pi miss estimates: 0/1")) throw Error("pending estimates not unknown");
const reply = (missed: number) => worker.onmessage({ data: { sessions: [{ warnings: [], turns: [{ responseId: "response", eligible: true, missed }] }], more: false } });
reply(7000);
if (!output.includes("Pi miss estimates: 1/1") || !output.includes("\x1b[31m█")) throw Error("async estimate not rendered red");
receive("r"); receive("r");
await Bun.sleep(0);
if (!output.includes("Pi miss estimates: 0/1")) throw Error("stale estimates shown during refresh");
reply(5000); // refresh arriving during in-flight parsing queues exactly one follow-up
if (Number(requests) !== 3) throw Error(`refresh not queued: ${requests}`);
reply(6000);
if (!output.includes("Pi miss estimates: 1/1")) throw Error("refreshed estimate missing");
if (!daemonReads) throw Error("accounting not fetched");
console.error("Recent async dispatch OK"); process.reallyExit(0);
