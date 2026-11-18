import { describe, expect, it } from "bun:test";
import { EventEmitter } from "events";
import { createMemoryUsageTrackingDriver } from "@routstr/sdk/storage";
import { createDaemonRequestHandler } from "./index";
import { __resetUsageSummaryCacheForTest } from "./usage-summary";

async function callSummary(query: string, endpoint = "/usage/summary") {
  __resetUsageSummaryCacheForTest();
  const handler = createDaemonRequestHandler({
    store: { getState: () => ({ clientIds: [] }) },
    usageTrackingDriver: createMemoryUsageTrackingDriver([{
      id: "entry", timestamp: Date.now(), baseUrl: "https://provider.example/",
      requestId: "request", modelId: "model", cost: 0, satsCost: 1,
      promptTokens: 1, completionTokens: 1, totalTokens: 2,
    }]),
  } as any);
  const req = new EventEmitter() as any;
  req.method = "GET";
  req.url = `${endpoint}?${query}`;
  req.headers = { host: "localhost" };
  const res = {
    status: 0, body: "",
    writeHead(status: number) { this.status = status; return this; },
    end(chunk?: string) { this.body += chunk ?? ""; return this; },
  };
  await handler(req, res as any);
  return { status: res.status, json: JSON.parse(res.body) };
}

describe("GET /usage/summary timezone", () => {
  it("rejects invalid timezone identifiers", async () => {
    const res = await callSummary("window=7d&timezone=Invalid/Zone");
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("IANA timezone");
  });

  it("accepts an encoded IANA timezone", async () => {
    const res = await callSummary("window=7d&tz=300&timezone=America%2FNew_York");
    expect(res.status).toBe(200);
    expect(res.json.output.window.totals.requests).toBe(1);
    expect(res.json.output.window.timeline.points.length).toBe(28);
  });

  it("retains fixed-offset compatibility without a timezone", async () => {
    const res = await callSummary("window=7d&tz=300");
    expect(res.status).toBe(200);
    expect(res.json.output.window.totals.requests).toBe(1);
  });
});


describe("unknown owner usage filters", () => {
  it("returns empty summary rather than all usage for an unmatched owner", async () => {
    const res = await callSummary("npub=unknown&window=7d");
    expect(res.status).toBe(200);
    expect(res.json.output.totals.requests).toBe(0);
    expect(res.json.output.window.totals.requests).toBe(0);
    expect(res.json.output.recent).toEqual([]);
  });

  it("returns an empty usage list for an unmatched owner", async () => {
    const res = await callSummary("npub=unknown", "/usage");
    expect(res.status).toBe(200);
    expect(res.json.output).toEqual([]);
  });
});
