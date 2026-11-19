import { describe, expect, test } from "bun:test";
import { withStallTimeout } from "./daemon-client";

function streamOf(chunks: string[], stallAfter = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
        return;
      }
      if (stallAfter) {
        // Never settles: models a daemon that sent its headers then wedged.
        await new Promise(() => {});
      }
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

describe("streamed daemon responses", () => {
  test("passes chunks through and closes cleanly", async () => {
    const body = withStallTimeout(streamOf(['{"a":1}\n', '{"b":2}\n']), 1_000);
    expect(await drain(body!)).toBe('{"a":1}\n{"b":2}\n');
  });

  test("does not charge total duration against the stall bound", async () => {
    // Six chunks, 15ms apart: 90ms total under a 40ms bound. Each gap is
    // under the bound, so the stream must survive even though it outlives it.
    const encoder = new TextEncoder();
    let sent = 0;
    const body = withStallTimeout(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent === 6) {
            controller.close();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 15));
          sent += 1;
          controller.enqueue(encoder.encode("x"));
        },
      }),
      40,
    );
    const started = Date.now();
    expect(await drain(body!)).toBe("xxxxxx");
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  test("fails a stream that goes quiet instead of hanging", async () => {
    const body = withStallTimeout(streamOf(["start\n"], true), 20);
    await expect(drain(body!)).rejects.toThrow("sent no response for 0.02s");
  });

  test("returns a missing body unchanged", () => {
    expect(withStallTimeout(null, 100)).toBeNull();
  });
});
