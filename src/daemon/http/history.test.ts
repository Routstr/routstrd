import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import type { HistoryEntry } from "@cashu/coco-core";
import {
  createDaemonRequestHandler,
  getHistoryByTypes,
  parseHistoryTypes,
} from "./index";

const MINT_URL = "https://mint.example/";

function makeEntry(
  id: string,
  type: HistoryEntry["type"],
  createdAt: number,
): HistoryEntry {
  return {
    id,
    type,
    createdAt,
    mintUrl: MINT_URL,
    unit: "sat",
    amount: 21,
  } as HistoryEntry;
}

const ENTRIES: HistoryEntry[] = [
  makeEntry("send-1", "send", 4),
  makeEntry("receive-1", "receive", 3),
  makeEntry("mint-1", "mint", 2),
  makeEntry("melt-1", "melt", 1),
  makeEntry("send-2", "send", 0),
];

function makeWalletClient(entries: HistoryEntry[] = ENTRIES) {
  return {
    getHistory: async (offset = 0, limit = 50) =>
      entries.slice(offset, offset + limit),
    getHistoryEntryById: async (id: string) =>
      entries.find((entry) => entry.id === id) ?? null,
  };
}

function makeReq(method: string, path: string) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = { host: "localhost" };
  return req;
}

function makeRes() {
  const res: any = {
    status: 0,
    body: "",
    writeHead(status: number) {
      res.status = status;
      return res;
    },
    end(chunk?: string) {
      if (chunk) res.body += chunk;
      return res;
    },
    json() {
      return JSON.parse(res.body);
    },
  };
  return res;
}

async function callHistory(path: string, entries?: HistoryEntry[]) {
  const handler = createDaemonRequestHandler({
    walletClient: makeWalletClient(entries),
  } as any);
  const res = makeRes();
  await handler(makeReq("GET", path), res);
  return res;
}

describe("parseHistoryTypes", () => {
  it("splits, trims, and lowercases comma-separated values", () => {
    expect(parseHistoryTypes(" Send , MINT ")).toEqual(["send", "mint"]);
  });

  it("returns an empty list for missing or blank input", () => {
    expect(parseHistoryTypes(null)).toEqual([]);
    expect(parseHistoryTypes("")).toEqual([]);
    expect(parseHistoryTypes(" , ")).toEqual([]);
  });
});

describe("getHistoryByTypes", () => {
  it("filters by type and applies offset/limit after filtering", async () => {
    const client = makeWalletClient();
    expect(await getHistoryByTypes(client, ["send"], 0, 10)).toEqual([
      ENTRIES[0]!,
      ENTRIES[4]!,
    ]);
    expect(await getHistoryByTypes(client, ["send"], 1, 1)).toEqual([
      ENTRIES[4]!,
    ]);
  });

  it("scans past the page size boundary to find matches", async () => {
    const filler = Array.from({ length: 250 }, (_, index) =>
      makeEntry(`receive-${index}`, "receive", index),
    );
    const target = makeEntry("mint-late", "mint", -1);
    const client = makeWalletClient([...filler, target]);

    expect(await getHistoryByTypes(client, ["mint"], 0, 10)).toEqual([target]);
  });

  it("returns no entries when nothing matches", async () => {
    const client = makeWalletClient([makeEntry("mint-1", "mint", 1)]);
    expect(await getHistoryByTypes(client, ["send"], 0, 10)).toEqual([]);
  });
});

describe("GET /wallet/history", () => {
  it("returns all entries without a filter", async () => {
    const res = await callHistory("/wallet/history");
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.output.entries.map((e: HistoryEntry) => e.id)).toEqual([
      "send-1",
      "receive-1",
      "mint-1",
      "melt-1",
      "send-2",
    ]);
  });

  it("filters entries by a comma-separated type list", async () => {
    const res = await callHistory("/wallet/history?type=send,melt");
    const body = res.json();
    expect(body.output.entries.map((e: HistoryEntry) => e.id)).toEqual([
      "send-1",
      "melt-1",
      "send-2",
    ]);
  });

  it("honors offset/limit for filtered results", async () => {
    const res = await callHistory("/wallet/history?type=send&offset=1&limit=1");
    const body = res.json();
    expect(body.output.entries.map((e: HistoryEntry) => e.id)).toEqual([
      "send-2",
    ]);
  });

  it("looks up a single entry by id", async () => {
    const res = await callHistory("/wallet/history?id=mint-1");
    const body = res.json();
    expect(body.output.entries.map((e: HistoryEntry) => e.id)).toEqual([
      "mint-1",
    ]);
  });

  it("returns an empty list when the id is unknown", async () => {
    const res = await callHistory("/wallet/history?id=does-not-exist");
    const body = res.json();
    expect(body.output.entries).toEqual([]);
  });
});
