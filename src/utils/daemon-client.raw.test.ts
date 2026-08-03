import { afterEach, describe, expect, mock, test } from "bun:test";

// Keep the test off the real config file: callDaemonRaw() resolves the daemon
// base URL through loadConfig(). Everything else in the module is passed
// through, since the import graph reads paths and defaults from it too.
const realConfig = await import("./config");
mock.module("./config", () => ({
  ...realConfig,
  loadConfig: async () => ({ port: 8008, host: "127.0.0.1" }),
}));

const { callDaemonRaw } = await import("./daemon-client");

const originalFetch = globalThis.fetch;
const originalAbortTimeout = AbortSignal.timeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalAbortTimeout;
});

describe("callDaemonRaw", () => {
  test("arms no total deadline, only an inactivity bound", async () => {
    // Regression: `fetchDaemonUrl` used to default its timeout argument, so
    // passing `undefined` re-armed the 120s route deadline and killed long
    // streams mid-body.
    const armed: number[] = [];
    AbortSignal.timeout = ((ms: number) => {
      armed.push(ms);
      return originalAbortTimeout(ms);
    }) as typeof AbortSignal.timeout;

    let signalSeen: AbortSignal | null | undefined;
    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      signalSeen = init?.signal;
      return new Response('{"type":"result","ok":true,"message":"done"}\n');
    }) as unknown as typeof fetch;

    const response = await callDaemonRaw("/wallet/recover/mint", {
      method: "POST",
      body: { url: "https://mint.example.com" },
    });

    expect(armed).toEqual([]);
    expect(signalSeen).toBeUndefined();
    expect(await response.text()).toContain('"ok":true');
  });

  test("bounds inactivity on the streamed body", async () => {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first\n"));
            // ...then the daemon goes quiet.
          },
        }),
      )) as unknown as typeof fetch;

    const response = await callDaemonRaw("/wallet/recover/mint", {
      method: "POST",
      body: {},
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "first\n",
    );
    // The default inactivity bound is 120s; the real one is not waited out
    // here, only asserted through the wrapper's own unit tests.
    await reader.cancel().catch(() => {});
  });
});
