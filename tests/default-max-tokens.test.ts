import { describe, expect, test } from "bun:test";
import {
  applyDefaultMaxTokens,
  isCompletionPath,
  resolveDefaultMaxTokens,
} from "../src/daemon/http/default-max-tokens";

const CHAT = "/v1/chat/completions";

describe("default max_tokens", () => {
  test("injects a cap when the client omits max_tokens", () => {
    const { body, injected } = applyDefaultMaxTokens(
      { model: "kimi-k3", messages: [] },
      CHAT,
      8192,
    );
    expect(injected).toBe(8192);
    expect(body.max_tokens).toBe(8192);
  });

  test("never overrides an explicit max_tokens", () => {
    const { body, injected } = applyDefaultMaxTokens(
      { model: "kimi-k3", messages: [], max_tokens: 16 },
      CHAT,
      8192,
    );
    expect(injected).toBeNull();
    expect(body.max_tokens).toBe(16);
  });

  test("respects the newer max_completion_tokens spelling", () => {
    const { injected } = applyDefaultMaxTokens(
      { model: "kimi-k3", messages: [], max_completion_tokens: 32 },
      CHAT,
      8192,
    );
    expect(injected).toBeNull();
  });

  test("treats an explicit null as a deliberate 'unbounded'", () => {
    const { injected } = applyDefaultMaxTokens(
      { model: "kimi-k3", messages: [], max_tokens: null },
      CHAT,
      8192,
    );
    expect(injected).toBeNull();
  });

  test("does not mutate the caller's body", () => {
    const original = { model: "kimi-k3", messages: [] };
    applyDefaultMaxTokens(original, CHAT, 8192);
    expect("max_tokens" in original).toBe(false);
  });

  test("only touches completion endpoints", () => {
    expect(isCompletionPath("/v1/chat/completions")).toBe(true);
    expect(isCompletionPath("/v1/completions")).toBe(true);
    expect(isCompletionPath("/v1/models")).toBe(false);
    expect(isCompletionPath("/v1/embeddings")).toBe(false);

    const { injected } = applyDefaultMaxTokens({ model: "x" }, "/v1/embeddings", 8192);
    expect(injected).toBeNull();
  });

  test("can be disabled entirely", () => {
    const { body, injected } = applyDefaultMaxTokens(
      { model: "kimi-k3", messages: [] },
      CHAT,
      null,
    );
    expect(injected).toBeNull();
    expect("max_tokens" in body).toBe(false);
  });
});

describe("resolveDefaultMaxTokens", () => {
  function withEnv(value: string | undefined, fn: () => void): void {
    const previous = process.env.ROUTSTRD_DEFAULT_MAX_TOKENS;
    if (value === undefined) delete process.env.ROUTSTRD_DEFAULT_MAX_TOKENS;
    else process.env.ROUTSTRD_DEFAULT_MAX_TOKENS = value;
    try {
      fn();
    } finally {
      if (previous === undefined) delete process.env.ROUTSTRD_DEFAULT_MAX_TOKENS;
      else process.env.ROUTSTRD_DEFAULT_MAX_TOKENS = previous;
    }
  }

  test("defaults to 8192", () => {
    withEnv(undefined, () => expect(resolveDefaultMaxTokens()).toBe(8192));
  });

  test("honours an explicit override", () => {
    withEnv("2048", () => expect(resolveDefaultMaxTokens()).toBe(2048));
  });

  test("supports opting out", () => {
    for (const off of ["off", "0", "false", ""]) {
      withEnv(off, () => expect(resolveDefaultMaxTokens()).toBeNull());
    }
  });

  test("falls back to the default for nonsense values", () => {
    withEnv("banana", () => expect(resolveDefaultMaxTokens()).toBe(8192));
  });
});
