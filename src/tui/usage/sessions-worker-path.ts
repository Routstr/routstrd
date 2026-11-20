/** Bun preserves worker entry paths in compiled executables, unlike the main entry. */
export function sessionsWorkerPath(): string {
  if (import.meta.url.startsWith("file:///$bunfs/")) {
    return new URL("./tui/usage/sessions-worker.js", import.meta.url).href;
  }
  return new URL("./sessions-worker.ts", import.meta.url).href;
}
