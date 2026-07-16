import type { CocodClient } from "./cocod-client";
import { isMintUnreachableError } from "./mint-fallback";

type LoggerLike = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

type TopUpOptions = {
  mintUrl: string;
  baseUrl: string;
  amount: number;
  token?: string;
};

type TopUpResult = {
  success: boolean;
  message?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

type BalanceManagerLike = {
  topUp(options: TopUpOptions): Promise<TopUpResult>;
};

type RoutstrClientLike = {
  getBalanceManager(): unknown;
};

type WalletAdapterLike = {
  getBalances(): Promise<Record<string, number>>;
};

const PATCH_MARKER = Symbol.for("routstrd.mintFallbackTopUpPatched");
const ERROR_RETRY_PATCH_MARKER = Symbol.for("routstrd.mintFallbackErrorRetryPatched");

function uniqueMintUrls(mints: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const mint of mints) {
    const trimmed = mint?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isMintUnreachableTopUpResult(result: TopUpResult): boolean {
  return !result.success &&
    (isMintUnreachableError(result.message) || isMintUnreachableError(result.error));
}

function isMintUnreachableResponse(status: number, responseBody: unknown): boolean {
  return status >= 500 && isMintUnreachableError(responseBody);
}

async function getTopUpMintCandidates(
  initialMintUrl: string,
  walletClient: CocodClient,
  walletAdapter: WalletAdapterLike,
): Promise<string[]> {
  const [configuredMints, balances] = await Promise.all([
    walletClient.listMints().catch(() => []),
    walletAdapter.getBalances().catch(() => ({})),
  ]);

  return uniqueMintUrls([
    initialMintUrl,
    ...configuredMints,
    ...Object.keys(balances),
  ]);
}

export function installMintFallbackTopUp(
  client: RoutstrClientLike,
  walletClient: CocodClient,
  walletAdapter: WalletAdapterLike,
  logger: LoggerLike,
): void {
  installMintUnreachableErrorRetry(client, walletClient, walletAdapter, logger);

  const balanceManager = client.getBalanceManager() as BalanceManagerLike & {
    [PATCH_MARKER]?: boolean;
  };
  if (balanceManager[PATCH_MARKER]) return;

  const originalTopUp = balanceManager.topUp.bind(balanceManager);
  balanceManager.topUp = async (options: TopUpOptions): Promise<TopUpResult> => {
    const candidates = await getTopUpMintCandidates(
      options.mintUrl,
      walletClient,
      walletAdapter,
    );

    let lastMintUnreachableResult: TopUpResult | undefined;
    for (const [index, mintUrl] of candidates.entries()) {
      if (index > 0) {
        logger.log(
          `[wallet] Retrying provider top-up with fallback mint ${mintUrl} (${index + 1}/${candidates.length})...`,
        );
      }

      const result = await originalTopUp({ ...options, mintUrl });
      if (!isMintUnreachableTopUpResult(result)) {
        return result;
      }

      lastMintUnreachableResult = result;
      logger.warn(
        `[wallet] Provider top-up mint unreachable for ${mintUrl}.` +
          (index + 1 < candidates.length ? " Trying next configured mint." : " No fallback mints left."),
      );
    }

    return lastMintUnreachableResult ?? originalTopUp(options);
  };

  balanceManager[PATCH_MARKER] = true;
}

export function installMintUnreachableErrorRetry(
  client: RoutstrClientLike,
  walletClient: CocodClient,
  walletAdapter: WalletAdapterLike,
  logger: LoggerLike,
): void {
  const patchedClient = client as RoutstrClientLike & Record<string, any> & { [ERROR_RETRY_PATCH_MARKER]?: boolean };
  if (patchedClient[ERROR_RETRY_PATCH_MARKER]) return;

  const originalHandleErrorResponse = patchedClient._handleErrorResponse;
  if (typeof originalHandleErrorResponse !== "function") return;

  patchedClient._handleErrorResponse = async function patchedHandleErrorResponse(
    this: Record<string, any>,
    params: Record<string, any>,
    token: string,
    status: number,
    requestId: string | undefined,
    xCashuRefundToken: string | undefined,
    responseBody: unknown,
    retryCount = 0,
  ): Promise<unknown> {
    const mode = this.mode;
    const baseUrl = params?.baseUrl;
    const initialMintUrl = params?.mintUrl;

    if (
      mode === "apikeys" &&
      baseUrl &&
      !params?.mintFallbackAttempted &&
      isMintUnreachableResponse(status, responseBody)
    ) {
      const candidates = (await getTopUpMintCandidates(
        initialMintUrl,
        walletClient,
        walletAdapter,
      )).filter((mintUrl) => mintUrl !== initialMintUrl);

      if (candidates.length > 0) {
        logger.warn(
          `[wallet] Provider ${baseUrl} rejected the stored API key because its source mint is unreachable. ` +
            `Trying ${candidates.length} fallback mint(s) before provider failover.`,
        );
      }

      for (const [index, mintUrl] of candidates.entries()) {
        try {
          this.storageAdapter?.removeApiKey?.(baseUrl);
          logger.log(
            `[wallet] Retrying ${baseUrl} with a fresh API key from fallback mint ${mintUrl} ` +
              `(${index + 1}/${candidates.length})...`,
          );

          const spendResult = await this._spendToken({
            mintUrl,
            amount: params.requiredSats,
            baseUrl,
            excludeMints: [initialMintUrl],
          });

          const retryToken = spendResult.token;
          if (!retryToken) {
            throw new Error("Fresh API key creation returned no token");
          }

          const retryResponse = await this._makeRequest({
            ...params,
            mintUrl,
            token: retryToken,
            requiredSats: params.requiredSats,
            headers: this._withAuthAndTinfoilHeaders(
              params.baseHeaders,
              retryToken,
              params.tinfoilEnabled,
              params.selectedModel?.id,
            ),
            retryCount: retryCount + 1,
            mintFallbackAttempted: true,
          });

          retryResponse.initialTokenBalanceInSats = spendResult.tokenBalanceUnit === "msat"
            ? spendResult.tokenBalance / 1_000
            : spendResult.tokenBalance;
          retryResponse.initialTokenBalanceUnknown = spendResult.tokenBalanceUnknown;
          return retryResponse;
        } catch (error) {
          logger.warn(
            `[wallet] Fallback mint ${mintUrl} could not create a replacement API key for ${baseUrl}: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    }

    return originalHandleErrorResponse.call(
      this,
      params,
      token,
      status,
      requestId,
      xCashuRefundToken,
      responseBody,
      retryCount,
    );
  };

  patchedClient[ERROR_RETRY_PATCH_MARKER] = true;
}
