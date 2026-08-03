import { describe, expect, it } from "bun:test";
import {
  consumeRecoveryStream,
  encodeRecoveryEvent,
} from "./recovery-stream";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("recovery NDJSON stream", () => {
  it("reports progress and returns the terminal success message", async () => {
    const progress: string[] = [];
    const body = stream([
      encodeRecoveryEvent({ type: "progress", message: "Scanning mint" }),
      encodeRecoveryEvent({ type: "result", ok: true, message: "Recovered" }),
    ]);

    await expect(
      consumeRecoveryStream(body, (message) => progress.push(message)),
    ).resolves.toBe("Recovered");
    expect(progress).toEqual(["Scanning mint"]);
  });

  it("handles events split across transport chunks", async () => {
    const encoded = encodeRecoveryEvent({
      type: "result",
      ok: true,
      message: "Recovered",
    });
    await expect(
      consumeRecoveryStream(stream([encoded.slice(0, 8), encoded.slice(8)])),
    ).resolves.toBe("Recovered");
  });

  it("propagates a terminal recovery failure", async () => {
    const body = stream([
      encodeRecoveryEvent({ type: "result", ok: false, error: "Mint failed" }),
    ]);
    await expect(consumeRecoveryStream(body)).rejects.toThrow("Mint failed");
  });

  it("rejects a truncated response without a terminal result", async () => {
    const body = stream([
      encodeRecoveryEvent({ type: "progress", message: "Scanning mint" }),
    ]);
    await expect(consumeRecoveryStream(body)).rejects.toThrow(
      "ended before a result",
    );
  });

  it("rejects an absent response body", async () => {
    await expect(consumeRecoveryStream(null)).rejects.toThrow(
      "no recovery response body",
    );
  });
});
