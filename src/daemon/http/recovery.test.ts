import { describe, expect, it } from "bun:test";
import type { ServerResponse } from "http";
import type { CocodClient } from "../wallet/cocod-client";
import { streamMintRecovery } from "./index";

function responseRecorder(): {
  response: ServerResponse;
  chunks: string[];
  headers: Record<string, string>;
} {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const response = {
    writeHead(_status: number, values: Record<string, string>) {
      Object.assign(headers, values);
      return this;
    },
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk) chunks.push(chunk);
      return this;
    },
  } as unknown as ServerResponse;
  return { response, chunks, headers };
}

function clientWithRecover(
  recoverMint: CocodClient["recoverMint"],
): CocodClient {
  return { recoverMint } as CocodClient;
}

describe("streamMintRecovery", () => {
  it("streams progress and a terminal success event", async () => {
    const recorder = responseRecorder();
    const client = clientWithRecover(async (_url, progress) => {
      progress?.("Scanning keysets");
      return "Recovery complete";
    });

    await streamMintRecovery(
      recorder.response,
      client,
      "https://mint.example.com",
    );

    expect(recorder.headers["Content-Type"]).toContain("application/x-ndjson");
    expect(recorder.chunks.map((line) => JSON.parse(line))).toEqual([
      { type: "progress", message: "Scanning keysets" },
      { type: "result", ok: true, message: "Recovery complete" },
    ]);
  });

  it("always terminates a started stream with an error result", async () => {
    const recorder = responseRecorder();
    const client = clientWithRecover(async (_url, progress) => {
      progress?.("Scanning keysets");
      throw new Error("Mint restore failed");
    });

    await streamMintRecovery(
      recorder.response,
      client,
      "https://mint.example.com",
    );

    expect(recorder.chunks.map((line) => JSON.parse(line))).toEqual([
      { type: "progress", message: "Scanning keysets" },
      { type: "result", ok: false, error: "Mint restore failed" },
    ]);
  });
});
