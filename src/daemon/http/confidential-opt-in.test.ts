import { describe, expect, it } from "bun:test";
import { isConfidentialPath, parseConfidentialOptIn } from "./confidential-opt-in";

describe("parseConfidentialOptIn", () => {
  it("treats a missing header as no opt-in", () => {
    expect(parseConfidentialOptIn(undefined).kind).toBe("absent");
  });

  it("accepts the one value, ignoring case and surrounding whitespace", () => {
    for (const v of ["confidential", "Confidential", " CONFIDENTIAL ", "\tconfidential\r", ["confidential"]]) {
      expect(parseConfidentialOptIn(v).kind).toBe("confidential");
    }
  });

  it("refuses near misses, lists and other values", () => {
    for (const v of [
      "",
      " ",
      "confidentail",
      "confidential1",
      "confidential, confidential",
      "confidential,plain",
      "con fidential",
      "true",
      "verified",
      ["confidential", "confidential"],
      [],
    ]) {
      const r = parseConfidentialOptIn(v);
      expect(r.kind).toBe("invalid");
      if (r.kind === "invalid") expect(r.error).toContain("x-routstr-verify");
    }
  });
});

describe("isConfidentialPath", () => {
  it("admits chat completions and image generation only", () => {
    for (const p of ["/v1/chat/completions", "/chat/completions/", "/v1/images/generations", "/v1/image/generate"]) {
      expect(isConfidentialPath(p)).toBe(true);
    }
    for (const p of ["/v1/responses", "/v1/images/edits", "/v1/embeddings", "/x/v1/chat/completions"]) {
      expect(isConfidentialPath(p)).toBe(false);
    }
  });
});
