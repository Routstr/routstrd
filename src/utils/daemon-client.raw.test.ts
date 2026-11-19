import { afterEach, describe, expect, mock, test } from "bun:test";

const realConfig = await import("./config");
mock.module("./config", () => ({
  ...realConfig,
  loadConfig: async () => ({ port: 8008, host: "127.0.0.1" }),
}));
const { callDaemonRaw } = await import("./daemon-client");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("callDaemonRaw", () => {
  test("aborts a request stalled before response headers", async () => {
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing signal"));
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    ) as unknown as typeof fetch;

    await expect(callDaemonRaw("/wallet/recover/mint", { method: "POST" }, 10))
      .rejects.toThrow("the operation may still be running");
  });

  test("clears the headers deadline while the streamed body is still active", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
      signal = init?.signal;
      let pulls = 0;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          await Bun.sleep(10);
          if (signal?.aborted) throw signal.reason;
          if (++pulls === 8) controller.close();
          else controller.enqueue(new Uint8Array([46]));
        },
      })));
    }) as unknown as typeof fetch;

    const response = await callDaemonRaw("/wallet/recover/mint", { method: "POST" }, 60);
    expect(await response.text()).toBe(".......");
    expect(signal?.aborted).toBe(false);
  });

  test("bounds inactivity on the streamed body", async () => {
    globalThis.fetch = mock(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first\n"));
      },
    }))) as unknown as typeof fetch;

    const response = await callDaemonRaw("/wallet/recover/mint", { method: "POST" }, 10);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
    await expect(reader.read()).rejects.toThrow("Daemon sent no response");
  });
});
