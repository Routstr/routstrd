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
