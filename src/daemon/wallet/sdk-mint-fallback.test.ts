import { describe, expect, it } from "bun:test";
import {
  installCreateProviderTokenFallback,
  installMintUnreachableErrorRetry,
} from "./sdk-mint-fallback";

const PRIMARY_MINT = "https://mint.minibits.cash/Bitcoin";
const FALLBACK_MINT = "https://mint.cubabitcoin.org";
const PROVIDER = "https://routstr.otrta.me/";

function silentLogger() {
  return {
    log: (..._args: unknown[]) => {},
    warn: (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => {},
  };
}

function createXcashuErrorHarness() {
  const originalCalls: unknown[][] = [];
  const restoredTokens: string[] = [];
  const removedTokens: Array<[string, string]> = [];
  const spendCalls: Array<Record<string, unknown>> = [];
  const requestCalls: Array<Record<string, unknown>> = [];
  const retryResponse: Record<string, unknown> = { ok: true };

  const client: Record<string, any> = {
    mode: "xcashu",
    async _handleErrorResponse(...args: unknown[]) {
      originalCalls.push(args);
      return { delegated: true };
    },
    cashuSpender: {
      async receiveToken(token: string) {
        restoredTokens.push(token);
        return { success: true, amount: 305 };
      },
    },
    storageAdapter: {
      removeXcashuToken(baseUrl: string, token: string) {
        removedTokens.push([baseUrl, token]);
      },
    },
    async _spendToken(options: Record<string, unknown>) {
      spendCalls.push(options);
      return {
        token: "cashu-new-token",
        tokenBalance: 327,
        tokenBalanceUnit: "sat",
        tokenBalanceUnknown: false,
        selectedMintUrl: PRIMARY_MINT,
      };
    },
    async _makeRequest(options: Record<string, unknown>) {
      requestCalls.push(options);
      return retryResponse;
    },
    _withAuthAndTinfoilHeaders(
      baseHeaders: Record<string, string>,
      token: string,
    ) {
      return { ...baseHeaders, "X-Cashu": token };
    },
  };

  installMintUnreachableErrorRetry(
    client as any,
    { listMints: async () => [PRIMARY_MINT, FALLBACK_MINT] } as any,
    { getBalances: async () => ({ [PRIMARY_MINT]: 1_000 }) } as any,
    silentLogger(),
  );

  return {
    client,
    originalCalls,
    restoredTokens,
    removedTokens,
    spendCalls,
    requestCalls,
    retryResponse,
  };
}

function requestParams(overrides: Record<string, unknown> = {}) {
  return {
    path: "/v1/chat/completions",
    method: "POST",
    body: { model: "glm-5.3", messages: [] },
    selectedModel: { id: "glm-5.3" },
    baseUrl: PROVIDER,
    mintUrl: PRIMARY_MINT,
    selectedMintUrl: PRIMARY_MINT,
    token: "cashu-old-token",
    requiredSats: 305,
    headers: { "Content-Type": "application/json", "X-Cashu": "cashu-old-token" },
    baseHeaders: { "Content-Type": "application/json" },
    ...overrides,
  };
}

const minimumBalanceBody = JSON.stringify({
  detail: {
    reason: "Insufficient balance",
    amount_required_msat: 326_117,
    model: "glm-5.3",
    type: "minimum_balance_required",
  },
  request_id: "request-1",
});

describe("xcashu minimum-balance retry", () => {
  it("restores the undersized token and retries once with the provider-reported minimum", async () => {
    const harness = createXcashuErrorHarness();

    const response = await harness.client._handleErrorResponse(
      requestParams(),
      "cashu-old-token",
      402,
      "request-1",
      undefined,
      minimumBalanceBody,
      0,
    );

    expect(response).toBe(harness.retryResponse);
    expect(harness.originalCalls).toHaveLength(0);
    expect(harness.restoredTokens).toEqual(["cashu-old-token"]);
    expect(harness.removedTokens).toEqual([[PROVIDER, "cashu-old-token"]]);
    expect(harness.spendCalls).toEqual([
      {
        mintUrl: PRIMARY_MINT,
        amount: 327,
        baseUrl: PROVIDER,
      },
    ]);
    expect(harness.requestCalls).toHaveLength(1);
    expect(harness.requestCalls[0]).toMatchObject({
      baseUrl: PROVIDER,
      mintUrl: PRIMARY_MINT,
      token: "cashu-new-token",
      selectedMintUrl: PRIMARY_MINT,
      requiredSats: 327,
      retryCount: 1,
      minimumBalanceRetryProvider: PROVIDER,
      headers: {
        "Content-Type": "application/json",
        "X-Cashu": "cashu-new-token",
      },
    });
    expect(harness.retryResponse.initialTokenBalanceInSats).toBe(327);
    expect(harness.retryResponse.initialTokenBalanceUnknown).toBe(false);
  });

  it("delegates after the bounded retry has already been attempted", async () => {
    const harness = createXcashuErrorHarness();

    const response = await harness.client._handleErrorResponse(
      requestParams({ minimumBalanceRetryProvider: PROVIDER }),
      "cashu-old-token",
      402,
      "request-1",
      undefined,
      minimumBalanceBody,
      1,
    );

    expect(response).toEqual({ delegated: true });
    expect(harness.originalCalls).toHaveLength(1);
    expect(harness.restoredTokens).toHaveLength(0);
    expect(harness.spendCalls).toHaveLength(0);
    expect(harness.requestCalls).toHaveLength(0);
  });

  it("does not treat a generic insufficient-quota 402 as an xcashu sizing error", async () => {
    const harness = createXcashuErrorHarness();
    const quotaBody = JSON.stringify({
      error: {
        type: "insufficient_quota",
        code: "insufficient_balance",
        required_msats: 326_117,
      },
    });

    const response = await harness.client._handleErrorResponse(
      requestParams(),
      "cashu-old-token",
      402,
      "request-2",
      undefined,
      quotaBody,
      0,
    );

    expect(response).toEqual({ delegated: true });
    expect(harness.originalCalls).toHaveLength(1);
    expect(harness.restoredTokens).toHaveLength(0);
    expect(harness.spendCalls).toHaveLength(0);
  });

  it("does not spend a second token when the rejected token cannot be reclaimed", async () => {
    const harness = createXcashuErrorHarness();
    harness.client.cashuSpender.receiveToken = async (token: string) => {
      harness.restoredTokens.push(token);
      return { success: false, message: "proofs are still reserved" };
    };

    const response = await harness.client._handleErrorResponse(
      requestParams(),
      "cashu-old-token",
      402,
      "request-3",
      undefined,
      minimumBalanceBody,
      0,
    );

    expect(response).toEqual({ delegated: true });
    expect(harness.originalCalls).toHaveLength(1);
    expect(harness.restoredTokens).toEqual(["cashu-old-token"]);
    expect(harness.spendCalls).toHaveLength(0);
    expect(harness.removedTokens).toHaveLength(0);
  });

  it("preserves the API-key 402 parser for wrapped authoritative amounts", async () => {
    const harness = createXcashuErrorHarness();
    harness.client.mode = "apikeys";
    const quotaBody = JSON.stringify({
      detail: {
        error: {
          type: "insufficient_quota",
          code: "insufficient_balance",
        },
        amount_required_msat: 326_117,
      },
    });

    await harness.client._handleErrorResponse(
      requestParams(),
      "stored-api-key",
      402,
      "request-4",
      undefined,
      quotaBody,
      0,
    );

    const delegatedParams = harness.originalCalls[0]?.[0] as Record<string, unknown>;
    expect(delegatedParams.requiredSats).toBe(326.117);
    expect(harness.spendCalls).toHaveLength(0);
  });
});

describe("xcashu mint selection fallback", () => {
  it("tries the second configured mint when the primary mint has no proofs", async () => {
    const attemptedMints: string[] = [];
    const balanceManager = {
      async createProviderToken(options: { mintUrl: string }) {
        attemptedMints.push(options.mintUrl);
        if (options.mintUrl === PRIMARY_MINT) {
          return { success: false, error: "Not enough proofs to send" };
        }
        return {
          success: true,
          token: "cashu-fallback-token",
          selectedMintUrl: options.mintUrl,
        };
      },
    };
    const client = {
      mode: "xcashu",
      getMode: () => "xcashu",
      getBalanceManager: () => balanceManager,
    };

    installCreateProviderTokenFallback(
      client as any,
      { listMints: async () => [PRIMARY_MINT, FALLBACK_MINT] } as any,
      {
        getBalances: async () => ({
          [PRIMARY_MINT]: 0,
          [FALLBACK_MINT]: 1_000,
        }),
      } as any,
      silentLogger(),
    );

    const result = await balanceManager.createProviderToken({
      mintUrl: PRIMARY_MINT,
      baseUrl: PROVIDER,
      amount: 327,
    } as any);

    expect(result.success).toBe(true);
    expect(result.selectedMintUrl).toBe(FALLBACK_MINT);
    expect(attemptedMints).toEqual([PRIMARY_MINT, FALLBACK_MINT]);
  });
});
