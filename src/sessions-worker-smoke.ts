import { sessionsWorkerPath } from "./tui/usage/sessions-worker-path.ts";
const worker = new Worker(sessionsWorkerPath());
const timeout = setTimeout(() => { console.error("worker timeout"); process.exit(1); }, 5000);
worker.onerror = error => { console.error(error); process.exit(1); };
worker.onmessage = event => {
  clearTimeout(timeout);
  const result = event.data;
  if (!result.sessions?.some((s: {title: string}) => s.title === "Isolated runtime fixture") || !result.sessions?.some((s: {title: string; sourceLabel?: string}) => s.title === "Chat fixture title" && s.sourceLabel === "Bunkhouse test") || !result.error?.includes("Accounting unavailable")) {
    console.error(result); process.exit(1);
  }
  console.log("worker runtime OK", sessionsWorkerPath()); worker.terminate();
};
worker.postMessage(20);
