import { describe, expect, it } from "bun:test";
import { collectIncomingHeaders } from "./index";

describe("routstrd app attribution boundary", () => {
  it("preserves attribution headers for the SDK routing handoff", () => {
    const headers = collectIncomingHeaders({
      "http-referer": "https://hermes-agent.nousresearch.com",
      "x-title": "Hermes Agent",
      accept: "application/json",
    });

    expect(headers["http-referer"]).toBe("https://hermes-agent.nousresearch.com");
    expect(headers["x-title"]).toBe("Hermes Agent");
  });

  it("uses the first value when Node supplies a repeated header", () => {
    const headers = collectIncomingHeaders({ "x-title": ["Hermes Agent", "Other Agent"] });

    expect(headers["x-title"]).toBe("Hermes Agent");
  });
});
