import { describe, expect, test } from "bun:test";
import { confidentialErrorStatus } from "./index";

function confidentialError(code: string): Error {
  const e = new Error(`refused: ${code}`) as Error & { code: string };
  e.name = "ConfidentialError";
  e.code = code;
  return e;
}

describe("confidentialErrorStatus", () => {
  test("a request the confidential path cannot take is the caller's error", () => {
    expect(confidentialErrorStatus(confidentialError("unsupported_endpoint"))).toEqual({ status: 400, code: "unsupported_endpoint" });
    expect(confidentialErrorStatus(confidentialError("offer_no_images"))?.status).toBe(400);
  });
  test("a failed proof or receipt is a bad gateway", () => {
    expect(confidentialErrorStatus(confidentialError("receipt_verification"))).toEqual({ status: 502, code: "receipt_verification" });
    expect(confidentialErrorStatus(confidentialError("prover_failed"))?.status).toBe(502);
  });
  test("other errors are not mapped", () => {
    expect(confidentialErrorStatus(new Error("boom"))).toBeUndefined();
    expect(confidentialErrorStatus(null)).toBeUndefined();
  });
});
