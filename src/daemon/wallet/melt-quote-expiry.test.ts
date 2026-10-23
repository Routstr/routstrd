import { describe, expect, it } from "bun:test";
import { MintOperationError } from "@cashu/coco-core";
import type { Manager } from "@cashu/coco-core";
import {
  installMeltQuoteExpiryHandler,
  isMeltQuoteExpiredError,
} from "./melt-quote-expiry";

function fakeManager(registry: Record<string, unknown>): Manager {
  return {
    meltOperationService: {
      handlerProvider: {
        getAll: () => registry,
      },
    },
  } as unknown as Manager;
}

describe("isMeltQuoteExpiredError", () => {
  it("recognizes coco's MintOperationError with code 20007", () => {
    expect(isMeltQuoteExpiredError(new MintOperationError(20007, "quote expired"))).toBe(true);
  });

  it("recognizes a structurally identical error across the package boundary", () => {
    const error = Object.assign(new Error("quote expired"), { code: 20007 });
    expect(isMeltQuoteExpiredError(error)).toBe(true);
  });

  it("ignores other melt error codes", () => {
    expect(isMeltQuoteExpiredError(new MintOperationError(20002, "quote not paid"))).toBe(false);
  });

  it("ignores unrelated errors and non-objects", () => {
    expect(isMeltQuoteExpiredError(new Error("boom"))).toBe(false);
    expect(isMeltQuoteExpiredError("20007")).toBe(false);
    expect(isMeltQuoteExpiredError(null)).toBe(false);
  });
});

describe("installMeltQuoteExpiryHandler", () => {
  it("maps a 20007 from checkPending to a rollback decision", async () => {
    const calls: unknown[] = [];
    const registry: Record<string, unknown> = {
      bolt11: {
        checkPending: async (ctx: unknown) => {
          calls.push(ctx);
          throw new MintOperationError(20007, "quote expired");
        },
      },
    };
    const ok = installMeltQuoteExpiryHandler(fakeManager(registry));
    expect(ok).toBe(true);

    const decision = await (
      registry.bolt11 as { checkPending: (ctx: unknown) => Promise<unknown> }
    ).checkPending({ operation: { id: "op" } });
    expect(decision).toBe("rollback");
    expect(calls).toHaveLength(1);
  });

  it("passes through normal decisions and unrelated errors", async () => {
    const registry: Record<string, unknown> = {
      bolt11: {
        checkPending: async (ctx: { state?: string }) => {
          if (ctx.state === "boom") throw new Error("different failure");
          return "stay_pending";
        },
      },
    };
    installMeltQuoteExpiryHandler(fakeManager(registry));
    const handler = registry.bolt11 as {
      checkPending: (ctx: unknown) => Promise<unknown>;
    };
    expect(await handler.checkPending({})).toBe("stay_pending");
    await expect(handler.checkPending({ state: "boom" })).rejects.toThrow(
      "different failure",
    );
  });

  it("wraps every registered melt method", async () => {
    const registry: Record<string, unknown> = {
      bolt11: { checkPending: async () => "stay_pending" },
      bolt12: { checkPending: async () => "finalize" },
    };
    expect(installMeltQuoteExpiryHandler(fakeManager(registry))).toBe(true);
    // Both methods keep their own original decision.
    expect(
      await (registry.bolt11 as { checkPending: () => Promise<unknown> }).checkPending(),
    ).toBe("stay_pending");
    expect(
      await (registry.bolt12 as { checkPending: () => Promise<unknown> }).checkPending(),
    ).toBe("finalize");
  });

  it("skips handlers without checkPending and reports partial install", () => {
    const registry: Record<string, unknown> = {
      bolt11: { execute: async () => ({}) },
      bolt12: { checkPending: async () => "stay_pending" },
    };
    expect(installMeltQuoteExpiryHandler(fakeManager(registry))).toBe(true);
  });

  it("returns false when the registry is unavailable", () => {
    expect(installMeltQuoteExpiryHandler({} as Manager)).toBe(false);
    expect(
      installMeltQuoteExpiryHandler({
        meltOperationService: { handlerProvider: {} },
      } as unknown as Manager),
    ).toBe(false);
  });

  it("returns false when no handler exposes checkPending", () => {
    expect(
      installMeltQuoteExpiryHandler(
        fakeManager({ bolt11: { execute: async () => ({}) } }),
      ),
    ).toBe(false);
  });
});
