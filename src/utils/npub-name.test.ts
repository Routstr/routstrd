import { describe, expect, test } from "bun:test";
import {
  MAX_NPUB_NAME_LENGTH,
  NPUB_NAME_CANNOT_CLEAR_MESSAGE,
  NPUB_NAME_REQUIRED_MESSAGE,
  parseRequiredNpubName,
  parseUpdatedNpubName,
  validateNpubName,
} from "./npub-name";

describe("validateNpubName", () => {
  test("trims surrounding whitespace", () => {
    expect(validateNpubName("  Alice  ")).toEqual({ name: "Alice" });
  });

  test("accepts a name at the length cap", () => {
    const name = "x".repeat(MAX_NPUB_NAME_LENGTH);
    expect(validateNpubName(name)).toEqual({ name });
  });

  test("rejects a name over the length cap", () => {
    const result = validateNpubName("x".repeat(MAX_NPUB_NAME_LENGTH + 1));
    expect(result.name).toBeUndefined();
    expect(result.error).toContain(`Maximum length is ${MAX_NPUB_NAME_LENGTH}`);
  });

  test("counts code points, not UTF-16 units", () => {
    const name = "🦫".repeat(MAX_NPUB_NAME_LENGTH);
    expect(validateNpubName(name)).toEqual({ name });
    expect(validateNpubName("🦫".repeat(MAX_NPUB_NAME_LENGTH + 1)).error).toContain(
      "Maximum length",
    );
  });

  test("rejects empty and whitespace-only names", () => {
    expect(validateNpubName("")).toEqual({ error: NPUB_NAME_REQUIRED_MESSAGE });
    expect(validateNpubName("   ")).toEqual({ error: NPUB_NAME_REQUIRED_MESSAGE });
    expect(validateNpubName("\t\n")).toEqual({ error: NPUB_NAME_REQUIRED_MESSAGE });
  });
});

describe("parseRequiredNpubName", () => {
  test("reports a missing flag so the caller can prompt", () => {
    expect(parseRequiredNpubName(undefined)).toEqual({ missing: true });
  });

  test("does not report missing for a supplied value", () => {
    expect(parseRequiredNpubName("Alice")).toEqual({ name: "Alice" });
  });

  test("rejects an explicitly empty value instead of treating it as missing", () => {
    expect(parseRequiredNpubName("")).toEqual({ error: NPUB_NAME_REQUIRED_MESSAGE });
    expect(parseRequiredNpubName("  ")).toEqual({ error: NPUB_NAME_REQUIRED_MESSAGE });
  });

  test("still enforces the length cap", () => {
    expect(parseRequiredNpubName("x".repeat(MAX_NPUB_NAME_LENGTH + 1)).error).toContain(
      "Maximum length",
    );
  });
});

describe("parseUpdatedNpubName", () => {
  test("leaves the name untouched when the flag is omitted", () => {
    expect(parseUpdatedNpubName(undefined)).toEqual({});
  });

  test("accepts a new name", () => {
    expect(parseUpdatedNpubName(" Bob ")).toEqual({ name: "Bob" });
  });

  test("refuses to clear a name, with a message about clearing", () => {
    expect(parseUpdatedNpubName("")).toEqual({ error: NPUB_NAME_CANNOT_CLEAR_MESSAGE });
    expect(parseUpdatedNpubName("   ")).toEqual({ error: NPUB_NAME_CANNOT_CLEAR_MESSAGE });
  });

  test("still enforces the length cap", () => {
    expect(parseUpdatedNpubName("x".repeat(MAX_NPUB_NAME_LENGTH + 1)).error).toContain(
      "Maximum length",
    );
  });
});
