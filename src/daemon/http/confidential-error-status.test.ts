import { describe, expect, test } from "bun:test";
// The SDK's shape (client/confidential/errors.ts): a base class with a stable
// `code`, and subclasses that each overwrite `name`.
class ConfidentialError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ConfidentialError";
  }
}
const sub = (name: string, code: string) =>
  class extends ConfidentialError {
    constructor(message: string) {
      super(code, message);
      this.name = name;
    }
  };
const OfferUnpinnedError = sub("OfferUnpinnedError", "offer_unpinned");
const ProverMissingError = sub("ProverMissingError", "prover_missing");
const ReceiptVerificationError = sub("ReceiptVerificationError", "receipt_verification");
const SessionProtocolError = sub("SessionProtocolError", "session_protocol");
const TrustedHostError = sub("TrustedHostError", "trusted_host_rejected");
import { confidentialErrorStatus } from "./index";

describe("confidentialErrorStatus", () => {
  test("a request the confidential path cannot take is the caller's error", () => {
    expect(confidentialErrorStatus(new ConfidentialError("unsupported_endpoint", "no"))).toEqual({
      status: 400,
      code: "unsupported_endpoint",
    });
    expect(confidentialErrorStatus(new ConfidentialError("offer_no_images", "no"))?.status).toBe(400);
    expect(confidentialErrorStatus(new ConfidentialError("pinned_parameter", "no"))?.status).toBe(400);
  });
  test("the SDK's typed subclasses map by code", () => {
    expect(confidentialErrorStatus(new ReceiptVerificationError("bad"))).toEqual({ status: 502, code: "receipt_verification" });
    for (const e of [
      new OfferUnpinnedError("x"),
      new SessionProtocolError("x"),
      new TrustedHostError("x"),
      new ProverMissingError("x"),
    ]) {
      expect(e.name).not.toBe("ConfidentialError");
      expect(confidentialErrorStatus(e)?.status).toBe(502);
    }
  });
  test("other errors are not mapped", () => {
    expect(confidentialErrorStatus(new Error("boom"))).toBeUndefined();
    expect(confidentialErrorStatus(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeUndefined();
    expect(confidentialErrorStatus(null)).toBeUndefined();
  });
});
