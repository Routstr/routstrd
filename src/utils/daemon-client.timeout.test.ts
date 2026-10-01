import { afterEach, describe, expect, test } from "bun:test";
import { callDaemonUrl, DAEMON_REQUEST_TIMEOUT_MS } from "./daemon-client";
import { DEFAULT_CONFIG } from "./config";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

function shortenDeadline(): void {
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
    originalSetTimeout(callback, delay === DAEMON_REQUEST_TIMEOUT_MS ? 20 : delay, ...args)
  ) as typeof setTimeout;
}

function stalledResponse(status = 200): void {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"output":'));
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }), { status });
  }) as unknown as typeof fetch;
}

const request = (path = "/nwc/status") =>
  callDaemonUrl("http://daemon.example", path, {}, DEFAULT_CONFIG);

describe("NWC daemon request deadline", () => {
  test("bounds the wait for response headers", async () => {
    shortenDeadline();
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as unknown as typeof fetch;
    await expect(request()).rejects.toThrow("Daemon request timed out");
  });

  for (const status of [200, 500]) {
    test(`bounds a stalled ${status} response body`, async () => {
      shortenDeadline();
      stalledResponse(status);
      await expect(request()).rejects.toThrow("payment outcome is unknown");
    });
  }

  test("does not impose the NWC deadline on mint payment routes", async () => {
    let deadlines = 0;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === DAEMON_REQUEST_TIMEOUT_MS) deadlines++;
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout;
    globalThis.fetch = (async () => Response.json({ output: "paid" })) as unknown as typeof fetch;
    expect(await request("/wallet/send/bolt11")).toEqual({ output: "paid" });
    expect(deadlines).toBe(0);
  });

  test("clears the deadline after consuming a successful response", async () => {
    let cleared = 0;
    globalThis.clearTimeout = ((timer) => {
      cleared++;
      originalClearTimeout(timer as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout;
    globalThis.fetch = (async () => Response.json({ output: "ok" })) as unknown as typeof fetch;
    expect(await request()).toEqual({ output: "ok" });
    expect(cleared).toBe(1);
  });

  test("preserves HTTP errors rather than labeling them connection failures", async () => {
    globalThis.fetch = (async () => Response.json({ error: "restricted" }, { status: 403 })) as unknown as typeof fetch;
    await expect(request()).rejects.toThrow("restricted");
  });
});
