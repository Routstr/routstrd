import { describe, expect, it } from "bun:test";
import type { ServerResponse } from "http";
import type { WalletClient } from "../wallet/wallet-client";
import { streamMintRecovery } from "./index";

function responseRecorder(): {
  response: ServerResponse;
  chunks: string[];
  headers: Record<string, string>;
} {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const response: {
    writableEnded: boolean;
    destroyed: boolean;
    writeHead(status: number, values: Record<string, string>): unknown;
    once(): unknown;
    write(chunk: string): boolean;
    end(chunk?: string): unknown;
  } = {
    writableEnded: false,
    destroyed: false,
    writeHead(_status: number, values: Record<string, string>) {
      Object.assign(headers, values);
      return this;
    },
    once() {
      return this;
    },
    write(chunk: string) {
      if (this.writableEnded) throw new Error("write after end");
      chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (this.writableEnded) return this;
      if (chunk) chunks.push(chunk);
      this.writableEnded = true;
      return this;
    },
  };
  return {
    response: response as unknown as ServerResponse,
    chunks,
    headers,
  };
}

function clientWithRecover(recoverMint: WalletClient["recoverMint"]): WalletClient {
  return { recoverMint } as WalletClient;
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

  it("stops writing and still ends when the client disconnects", async () => {
    const recorder = responseRecorder();
    const client = clientWithRecover(async (_url, progress) => {
      progress?.("Scanning keysets");
      // The client goes away mid-restore, as with a Ctrl-C.
      (recorder.response as unknown as { destroyed: boolean }).destroyed = true;
      progress?.("Still restoring");
      return "Recovery complete";
    });

    await streamMintRecovery(
      recorder.response,
      client,
      "https://mint.example.com",
    );

    const events = recorder.chunks.map((line) => JSON.parse(line));
    expect(events).toEqual([
      { type: "progress", message: "Scanning keysets" },
    ]);
  });

  it("answers 501 when the wallet client has no mint recovery", async () => {
    const recorder = responseRecorder();

    await streamMintRecovery(
      recorder.response,
      {} as WalletClient,
      "https://mint.example.com",
    );

    expect(recorder.headers["Content-Type"]).toContain("application/json");
    expect(JSON.parse(recorder.chunks.join(""))).toEqual({
      error: "Mint proof recovery is not supported by this wallet client.",
    });
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
