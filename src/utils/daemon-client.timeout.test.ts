import { afterEach, describe, expect, test } from "bun:test";
import {
  callDaemonUrl,
  DAEMON_LONG_REQUEST_TIMEOUT_MS,
  DAEMON_REQUEST_TIMEOUT_MS,
} from "./daemon-client";
import { DEFAULT_CONFIG } from "./config";

const originalFetch = globalThis.fetch;
const originalAbortTimeout = AbortSignal.timeout;

/** Deadline (ms) passed to AbortSignal.timeout by the last request. */
let requestedDeadlines: number[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalAbortTimeout;
  requestedDeadlines = [];
});

/**
 * Record the requested deadline and arm a fast one instead, so tests do not
 * wait out the real 120s/600s bounds.
 */
function shortenDeadline(): void {
  AbortSignal.timeout = ((ms: number) => {
    requestedDeadlines.push(ms);
    return originalAbortTimeout(20);
  }) as typeof AbortSignal.timeout;
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

describe("daemon request deadline", () => {
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

  test("applies the default deadline to ordinary routes", async () => {
    shortenDeadline();
    globalThis.fetch = (async () => Response.json({ output: "ok" })) as unknown as typeof fetch;
    expect(await request("/nwc/status")).toEqual({ output: "ok" });
    expect(requestedDeadlines).toEqual([DAEMON_REQUEST_TIMEOUT_MS]);
  });

  for (const path of ["/wallet/send/bolt11", "/wallet/receive/cashu"]) {
    test(`uses the long deadline for value-moving route ${path}`, async () => {
      shortenDeadline();
      globalThis.fetch = (async () => Response.json({ output: "paid" })) as unknown as typeof fetch;
      expect(await request(path)).toEqual({ output: "paid" });
      expect(requestedDeadlines).toEqual([DAEMON_LONG_REQUEST_TIMEOUT_MS]);
    });
  }

  test("bounds a stalled body on a long-running route too", async () => {
    shortenDeadline();
    stalledResponse();
    await expect(request("/wallet/send/bolt11")).rejects.toThrow("payment outcome is unknown");
    expect(requestedDeadlines).toEqual([DAEMON_LONG_REQUEST_TIMEOUT_MS]);
  });

  test("preserves HTTP errors rather than labeling them connection failures", async () => {
    globalThis.fetch = (async () => Response.json({ error: "restricted" }, { status: 403 })) as unknown as typeof fetch;
    await expect(request()).rejects.toThrow("restricted");
  });
});
