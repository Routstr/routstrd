import type { CocodClient } from "./cocod-client";
import { isMintUnreachableError, receiveBolt11WithMintFallback } from "./mint-fallback";

type LoggerLike = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
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
  getMode?(): string;
};

type WalletAdapterLike = {
  getBalances(): Promise<Record<string, number>>;
  /** NWC auto-fund: creates invoice, pays it via Lightning, returns result */
  fundFromNWC?(amount: number): Promise<{
    success: boolean;
    invoice: string;
    preimage?: string;
    error?: string;
  }>;
  /** NWC connection status check */
  getNwcStatus?(): Promise<{
    connected: boolean;
    alias?: string;
    pubkey?: string;
    network?: string;
    methods?: string[];
    balance?: number;
    error?: string;
  }>;
  /** Pay an externally-created BOLT-11 invoice via NWC */
  payBolt11?(bolt11: string): Promise<{ success: boolean; preimage?: string; error?: string }>;
};

const PATCH_MARKER = Symbol.for("routstrd.mintFallbackTopUpPatched");
const ERROR_RETRY_PATCH_MARKER = Symbol.for("routstrd.mintFallbackErrorRetryPatched");
const CREATE_TOKEN_PATCH_MARKER = Symbol.for("routstrd.mintCreateTokenFallbackPatched");

// ── Routstr-core Lightning invoice integration ──────────────────
const ROUTSTR_CORE_INVOICE_POLL_MS = 5000;

/** POST /lightning/invoice on the upstream routstr-core provider. */
async function createInvoiceViaRoutstrCore(
  upstreamProviderUrl: string,
  amountSats: number,
  apiKey?: string,
): Promise<{ invoice_id: string; bolt11: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(upstreamProviderUrl);
  } catch {
    throw new Error(`Invalid provider URL: ${upstreamProviderUrl.slice(0, 50)}`);
  }
  const isLocalhost = parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1";
  if (parsedUrl.protocol !== "https:" && !isLocalhost) {
    throw new Error(`Provider URL must be HTTPS (got ${parsedUrl.protocol})`);
  }

  // Amount validation — routstr-core enforces 1 < amount <= 1_000_000
  if (!amountSats || amountSats <= 0) {
    throw new Error(`Invalid amount: ${amountSats} (must be > 0)`);
  }
  // routstr-core requires integer sats — floor any fractional amount
  amountSats = Math.ceil(amountSats);
  if (amountSats > 1_000_000) {
    throw new Error(`Amount ${amountSats} exceeds routstr-core max (1_000_000 sats)`);
  }

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const body: Record<string, unknown> = { amount_sats: amountSats, purpose: "create" };
    // If we have an existing API key for this provider, topup it instead of creating a new one.
    if (apiKey) {
      body.purpose = "topup";
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const resp = await fetch(`${parsedUrl.origin}/lightning/invoice`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const data = (await resp.json()) as { invoice_id?: string; bolt11?: string };
    if (!data.invoice_id || typeof data.invoice_id !== "string" || data.invoice_id.length === 0) {
      throw new Error("Missing or empty invoice_id in routstr-core response");
    }
    if (!data.bolt11 || typeof data.bolt11 !== "string" || !data.bolt11.startsWith("lnbc")) {
      throw new Error("Missing or invalid bolt11 (must start with 'lnbc') in routstr-core response");
    }
    return { invoice_id: data.invoice_id, bolt11: data.bolt11 };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Try to pay a Lightning invoice via NWC. Returns true if paid.
 * Used for BOTH local-wallet and routstr-core invoices.
 */
async function payInvoiceViaNwc(
  walletAdapter: WalletAdapterLike,
  bolt11: string,
  amountSats: number,
  logger: LoggerLike,
): Promise<boolean> {
  if (!walletAdapter.getNwcStatus || typeof walletAdapter.payBolt11 !== "function") {
    return false;
  }
  try {
    const nwcStatus = await walletAdapter.getNwcStatus();
    if (!nwcStatus.connected) {
      return false;
    }
    logger.log(`[wallet] NWC connected — attempting to pay Lightning invoice (${amountSats} sats)...`);
    // Use the direct pay path (payBolt11) — the wallet adapter wraps the
    // underlying NWC wallet's payInvoice call for externally-created invoices.
    const result = await walletAdapter.payBolt11!(bolt11);
    if (result.success) {
      logger.log(
        `[wallet] ✅ NWC paid invoice! Preimage: ${result.preimage?.slice(0, 16) ?? "N/A"}...`,
      );
      return true;
    }
    logger.error(`[wallet] NWC pay failed: ${result.error || "unknown error"}`);
    return false;
  } catch (nwcError) {
    logger.error(
      `[wallet] NWC pay error: ${nwcError instanceof Error ? nwcError.message : String(nwcError)}`,
    );
    return false;
  }
}

/** Non-blocking poller: watches a routstr-core invoice until paid/expired. */
function pollRoutstrCoreInvoice(
  upstreamProviderUrl: string,
  invoiceId: string,
  amountSats: number,
  logger: LoggerLike,
): void {
  let polls = 0;
  const maxPolls = 84; // ~7 min at 5s
  const interval = setInterval(async () => {
    polls++;
    try {
      const resp = await fetch(
        `${upstreamProviderUrl}/lightning/invoice/${invoiceId}/status`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!resp.ok) return;
      const data = (await resp.json()) as { status?: string; api_key?: string };
      if (data.status === "paid") {
        clearInterval(interval);
        logger.log(
          `[wallet] \u2705 Routstr-core invoice ${invoiceId} PAID! ${amountSats} sats credited via routstr-core.` +
            (data.api_key ? ` API key: ${data.api_key.slice(0, 8)}...` : ""),
        );
        return;
      }
      if (data.status === "expired") {
        clearInterval(interval);
        logger.warn(`[wallet] Routstr-core invoice ${invoiceId} EXPIRED.`);
        return;
      }
    } catch { /* transient */ }
    if (polls >= maxPolls) {
      clearInterval(interval);
      logger.warn(`[wallet] Stopped polling routstr-core invoice ${invoiceId} after ${polls} attempts.`);
    }
  }, ROUTSTR_CORE_INVOICE_POLL_MS);
}
// ── End routstr-core helpers ────────────────────────────────────

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

function getProviderReportedRequirement(
  responseBody: unknown,
): { type: string; sats: number } | undefined {
  let payload: unknown = responseBody;
  if (typeof responseBody === "string") {
    try {
      payload = JSON.parse(responseBody);
    } catch {
      return undefined;
    }
  }

  if (!payload || typeof payload !== "object") return undefined;
  const root = payload as Record<string, any>;
  const candidates = [
    root.detail?.error,
    root.error,
    root.detail,
    root,
  ].filter(
    (candidate): candidate is Record<string, any> =>
      Boolean(candidate) && typeof candidate === "object",
  );
  const error = candidates.find(
    (candidate) =>
      (candidate.type === "insufficient_quota" &&
        candidate.code === "insufficient_balance") ||
      candidate.type === "minimum_balance_required",
  );
  if (!error) return undefined;

  const explicitMsats = [
    error.amount_required_msat,
    error.amount_required_msats,
    error.required_msats,
    root.detail?.amount_required_msat,
    root.detail?.amount_required_msats,
    root.detail?.required_msats,
    root.amount_required_msat,
    root.amount_required_msats,
    root.required_msats,
  ]
    .map(Number)
    .find((amount) => Number.isFinite(amount) && amount > 0);
  if (explicitMsats !== undefined) {
    return { type: error.type, sats: explicitMsats / 1_000 };
  }

  const explicitSats = [
    error.amount_required_sat,
    error.amount_required_sats,
    error.required_sats,
    root.detail?.amount_required_sat,
    root.detail?.amount_required_sats,
    root.detail?.required_sats,
    root.amount_required_sat,
    root.amount_required_sats,
    root.required_sats,
  ]
    .map(Number)
    .find((amount) => Number.isFinite(amount) && amount > 0);
  if (explicitSats !== undefined) {
    return { type: error.type, sats: explicitSats };
  }

  const message = typeof error.message === "string"
    ? error.message
    : typeof error.reason === "string"
      ? error.reason
      : "";
  const satsAndMsats = message.match(
    /([\d,.]+)\s*sats?\s*\(([\d,]+)\s*msats?\)\s*required/i,
  );
  if (satsAndMsats) {
    const msats = Number(satsAndMsats[2]!.replaceAll(",", ""));
    if (Number.isFinite(msats) && msats > 0) {
      return { type: error.type, sats: msats / 1_000 };
    }
  }

  const satsOnly = message.match(/([\d,.]+)\s*sats?\s+required/i);
  if (satsOnly) {
    const sats = Number(satsOnly[1]!.replaceAll(",", ""));
    if (Number.isFinite(sats) && sats > 0) {
      return { type: error.type, sats };
    }
  }

  return undefined;
}

/** Returns true if the client is operating in xcashu mode. */
function isXcashuMode(client: RoutstrClientLike): boolean {
  const mode = client.getMode?.() ?? (client as Record<string, unknown>).mode;
  return mode === "xcashu";
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

export function installCreateProviderTokenFallback(
  client: RoutstrClientLike,
  walletClient: CocodClient,
  walletAdapter: WalletAdapterLike,
  logger: LoggerLike,
  upstreamProviderUrl?: string,
): void {
  const balanceManager = client.getBalanceManager() as BalanceManagerLike & {
    createProviderToken?: (options: TopUpOptions) => Promise<TopUpResult>;
    [CREATE_TOKEN_PATCH_MARKER]?: boolean;
  };
  if (balanceManager[CREATE_TOKEN_PATCH_MARKER] || typeof balanceManager.createProviderToken !== "function") return;

  const originalCreateProviderToken = balanceManager.createProviderToken.bind(balanceManager);

  balanceManager.createProviderToken = async (options: TopUpOptions): Promise<TopUpResult> => {
    const candidates = await getTopUpMintCandidates(
      options.mintUrl,
      walletClient,
      walletAdapter,
    );

    let lastResult: TopUpResult | undefined;
    for (const [index, mintUrl] of candidates.entries()) {
      if (index > 0) {
        logger.log(
          `[wallet] Retrying createProviderToken with fallback mint ${mintUrl} (${index + 1}/${candidates.length})...`,
        );
      }

      const result = await originalCreateProviderToken({ ...options, mintUrl });
      if (result.success) {
        return result;
      }

      // Retry the next mint only on wallet-empty / mint-unreachable errors.
      // Other errors (insufficient balance, invalid amount, network) are not
      // mint-specific and should propagate immediately.
      if (!isMintUnreachableError(result.error) && !isMintUnreachableError(result.message)) {
        return result;
      }

      lastResult = result;
      logger.warn(
        `[wallet] createProviderToken: mint ${mintUrl} failed (out of proofs / unreachable).` +
          (index + 1 < candidates.length ? " Trying next configured mint." : " No fallback mints left."),
      );
    }

    // ── Lightning invoice fallback ──────────────────────────────
    // All configured mints are empty or unreachable. In apikeys mode, fall
    // back to a Lightning invoice to fund the wallet. In xcashu mode this
    // makes no sense — tokens are per-request and refunded in the response,
    // so just let the error propagate to the next provider.
    if (isXcashuMode(client)) {
      logger.warn(
        `[wallet] createProviderToken: all ${candidates.length} mint(s) failed in xcashu mode — skipping Lightning fallback, letting provider failover handle it.`,
      );
      return lastResult ?? originalCreateProviderToken(options);
    }

    logger.warn(
      `[wallet] createProviderToken: all ${candidates.length} mint(s) unreachable or out of proofs. ` +
        `Attempting Lightning invoice top-up as final fallback...`,
    );

    const topUpAmount = Math.max(1, Math.min(Math.ceil(options.amount || 21), 1_000_000));

    try {
      let handled = false;

      // ── SECOND: Routstr-core Lightning invoice ──────────────
      // Prefer the actual upstream provider being requested (options.baseUrl)
      // over the static config provider URL. This credits the provider account
      // directly — no local wallet invoice needed.
      const coreProviderUrl = options.baseUrl || upstreamProviderUrl;
      if (coreProviderUrl) {
        try {
          const coreResult = await createInvoiceViaRoutstrCore(
            coreProviderUrl,
            topUpAmount,
            options.token,
          );
          if (coreResult) {
            logger.log(
              `[wallet] Routstr-core invoice: ${coreResult.bolt11} ` +
                `(${topUpAmount} sats, id=${coreResult.invoice_id}, provider=${coreProviderUrl})`,
            );

            // Try to pay via NWC
            const corePaid = await payInvoiceViaNwc(
              walletAdapter,
              coreResult.bolt11,
              topUpAmount,
              logger,
            );

            if (corePaid) {
              handled = true;
              pollRoutstrCoreInvoice(coreProviderUrl, coreResult.invoice_id, topUpAmount, logger);
              const retryResult = await originalCreateProviderToken(options);
              if (retryResult.success) {
                return retryResult;
              }
              logger.warn(
                `[wallet] createProviderToken still failed after routstr-core NWC payment — may need a moment for balance to settle.`,
              );
            } else {
              handled = true; // invoice created — surface it, don't fall through
              logger.log(`[wallet] Pay the routstr-core invoice above and retry.`);
              pollRoutstrCoreInvoice(coreProviderUrl, coreResult.invoice_id, topUpAmount, logger);
            }
          }
        } catch (coreError) {
          logger.error(
            `[wallet] Routstr-core invoice creation failed: ` +
              `${coreError instanceof Error ? coreError.message : String(coreError)}`,
          );
        }
      }

      // ── LAST: Local wallet Lightning invoice + NWC ──────────
      // Routstr-core invoice couldn't be created or paid. Create a local
      // wallet invoice and try to fund it via NWC.
      if (!handled) {
        const allMints = await walletClient.listMints().catch(() => candidates.filter(Boolean) as string[]);
        if (allMints.length > 0) {
          const { invoice, mintUrl } = await receiveBolt11WithMintFallback(
            walletClient,
            topUpAmount,
            allMints,
            "[wallet:create-token-fallback]",
          );

          logger.log(
            `[wallet] Local wallet Lightning invoice for ${topUpAmount} sats via ${mintUrl}: ${invoice}`,
          );

          const nwcPaid = await payInvoiceViaNwc(walletAdapter, invoice, topUpAmount, logger);
          if (nwcPaid) {
            const retryResult = await originalCreateProviderToken(options);
            if (retryResult.success) {
              return retryResult;
            }
            logger.warn(
              `[wallet] createProviderToken still failed after NWC payment — may need a moment for proofs to settle.`,
            );
          } else {
            logger.log(
              "[wallet] 💡 Manual top-up required: pay this invoice to fund the wallet and retry:",
            );
            logger.log(`  ${invoice}`);
            logger.log(`  Amount: ${topUpAmount} sats  |  Mint: ${mintUrl}`);
          }
        }
      }
    } catch (invoiceError) {
      logger.error(
        `[wallet] Lightning invoice fallback also failed: ` +
          `${invoiceError instanceof Error ? invoiceError.message : String(invoiceError)}`,
      );
    }

    return lastResult ?? originalCreateProviderToken(options);
  };

  balanceManager[CREATE_TOKEN_PATCH_MARKER] = true;
}

export function installMintFallbackTopUp(
  client: RoutstrClientLike,
  walletClient: CocodClient,
  walletAdapter: WalletAdapterLike,
  logger: LoggerLike,
  upstreamProviderUrl?: string,
): void {
  installMintUnreachableErrorRetry(client, walletClient, walletAdapter, logger);
  installCreateProviderTokenFallback(client, walletClient, walletAdapter, logger, upstreamProviderUrl);

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

    // ── Lightning invoice fallback ──────────────────────────────
    // All configured mints are empty or unreachable. In apikeys mode, fall
    // back to a Lightning invoice to fund the wallet. In xcashu mode this
    // makes no sense — tokens are per-request and refunded in the response,
    // so just let the error propagate to the next provider.
    if (isXcashuMode(client)) {
      logger.warn(
        `[wallet] All ${candidates.length} mint(s) failed in xcashu mode — skipping Lightning fallback, letting provider failover handle it.`,
      );
      return lastMintUnreachableResult ?? originalTopUp(options);
    }

    logger.warn(
      `[wallet] All ${candidates.length} mint(s) unreachable or out of proofs. ` +
        `Attempting Lightning invoice top-up as final fallback...`,
    );

    const topUpAmount = Math.max(1, Math.min(Math.ceil(options.amount || 21), 1_000_000)); // default to minimum

    try {
      let handled = false;

      // ── SECOND: Routstr-core Lightning invoice ──────────────
      // Prefer the actual upstream provider being requested (options.baseUrl)
      // over the static config provider URL. Credits the provider account directly.
      const coreProviderUrl = options.baseUrl || upstreamProviderUrl;
      if (coreProviderUrl) {
        try {
          const coreResult = await createInvoiceViaRoutstrCore(
            coreProviderUrl,
            topUpAmount,
            options.token,
          );
          if (coreResult) {
            logger.log(
              `[wallet] Routstr-core invoice: ${coreResult.bolt11} ` +
                `(${topUpAmount} sats, id=${coreResult.invoice_id}, provider=${coreProviderUrl})`,
            );

            const corePaid = await payInvoiceViaNwc(
              walletAdapter,
              coreResult.bolt11,
              topUpAmount,
              logger,
            );

            if (corePaid) {
              handled = true;
              pollRoutstrCoreInvoice(coreProviderUrl, coreResult.invoice_id, topUpAmount, logger);
              const retryResult = await originalTopUp(options);
              if (!isMintUnreachableTopUpResult(retryResult)) {
                return retryResult;
              }
              logger.warn(
                `[wallet] topUp still failed after routstr-core NWC payment — may need a moment for balance to settle.`,
              );
            } else {
              handled = true; // invoice created — surface it, don't fall through
              logger.log(`[wallet] Pay the routstr-core invoice above and retry.`);
              pollRoutstrCoreInvoice(coreProviderUrl, coreResult.invoice_id, topUpAmount, logger);
            }
          }
        } catch (coreError) {
          logger.error(
            `[wallet] Routstr-core invoice creation failed: ` +
              `${coreError instanceof Error ? coreError.message : String(coreError)}`,
          );
        }
      }

      // ── LAST: Local wallet Lightning invoice + NWC ──────────
      // Routstr-core invoice couldn't be created or paid. Create a local
      // wallet invoice and try to fund it via NWC.
      if (!handled) {
        const allMints = await walletClient.listMints().catch(() => candidates.filter(Boolean) as string[]);
        if (allMints.length > 0) {
          const { invoice, mintUrl } = await receiveBolt11WithMintFallback(
            walletClient,
            topUpAmount,
            allMints,
            "[wallet:topup-fallback]",
          );

          logger.log(
            `[wallet] Local wallet Lightning invoice for ${topUpAmount} sats via ${mintUrl}: ${invoice}`,
          );

          const nwcPaid = await payInvoiceViaNwc(walletAdapter, invoice, topUpAmount, logger);
          if (nwcPaid) {
            const retryResult = await originalTopUp(options);
            if (!isMintUnreachableTopUpResult(retryResult)) {
              return retryResult;
            }
            logger.warn(
              `[wallet] Top-up still failed after NWC payment — may need a moment for proofs to settle.`,
            );
          } else {
            logger.log(
              "[wallet] 💡 Manual top-up: pay this invoice to fund the wallet:",
            );
            logger.log(`  ${invoice}`);
            logger.log(`  Amount: ${topUpAmount} sats  |  Mint: ${mintUrl}`);
          }
        }
      }
    } catch (invoiceError) {
      logger.error(
        `[wallet] Lightning invoice fallback also failed: ` +
          `${invoiceError instanceof Error ? invoiceError.message : String(invoiceError)}`,
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
    const providerRequirement = status === 402
      ? getProviderReportedRequirement(responseBody)
      : undefined;
    const providerRequiredSats = providerRequirement?.sats;
    const localRequiredSats = Number(params?.requiredSats);

    if (
      mode === "apikeys" &&
      providerRequiredSats !== undefined &&
      (!Number.isFinite(localRequiredSats) || providerRequiredSats > localRequiredSats)
    ) {
      logger.warn(
        `[wallet] Provider reports ${providerRequiredSats} sats required, above local estimate ` +
          `${params?.requiredSats ?? "unknown"}; using provider requirement for balance validation and top-up.`,
      );
      params = { ...params, requiredSats: providerRequiredSats };
    }

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

    // Routstr-core reports the exact minimum for an undersized per-request
    // X-Cashu token. The SDK's normal 402 top-up path is API-key-only, so
    // reclaim the rejected token and retry this provider once with enough sats.
    if (
      mode === "xcashu" &&
      status === 402 &&
      baseUrl &&
      initialMintUrl &&
      retryCount < 2 &&
      params?.minimumBalanceRetryProvider !== baseUrl &&
      providerRequirement?.type === "minimum_balance_required" &&
      providerRequiredSats !== undefined &&
      (!Number.isFinite(localRequiredSats) || providerRequiredSats > localRequiredSats)
    ) {
      const recoveryTokens = [xCashuRefundToken, params?.token]
        .filter((candidate): candidate is string =>
          typeof candidate === "string" && candidate.startsWith("cashu")
        )
        .filter((candidate, index, all) => all.indexOf(candidate) === index);
      let recovered = false;
      let recoveredAmount: unknown;

      for (const recoveryToken of recoveryTokens) {
        try {
          const receiveResult = await this.cashuSpender?.receiveToken?.(recoveryToken);
          if (receiveResult?.success) {
            recovered = true;
            recoveredAmount = receiveResult.amount;
            break;
          }
          logger.warn(
            `[wallet] Could not restore undersized xcashu token before minimum-balance retry: ` +
              `${receiveResult?.message ?? "unknown error"}.`,
          );
        } catch (error) {
          logger.warn(
            `[wallet] Error restoring undersized xcashu token before minimum-balance retry: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }

      if (recovered) {
        this.storageAdapter?.removeXcashuToken?.(baseUrl, params.token);
        const retryAmountSats = Math.max(1, Math.ceil(providerRequiredSats));
        logger.warn(
          `[wallet] Provider ${baseUrl} requires ${providerRequiredSats} sats, above local estimate ` +
            `${params?.requiredSats ?? "unknown"}; restored ${recoveredAmount ?? "the"} sats and ` +
            `retrying once with ${retryAmountSats} sats.`,
        );

        const spendResult = await this._spendToken({
          mintUrl: initialMintUrl,
          amount: retryAmountSats,
          baseUrl,
        });
        const retryToken = spendResult?.token;
        if (!retryToken) {
          throw new Error("X-Cashu minimum-balance retry returned no token");
        }

        const retryResponse = await this._makeRequest({
          ...params,
          token: retryToken,
          selectedMintUrl: spendResult.selectedMintUrl,
          requiredSats: retryAmountSats,
          headers: this._withAuthAndTinfoilHeaders(
            params.baseHeaders,
            retryToken,
            params.tinfoilEnabled,
            params.selectedModel?.id,
          ),
          retryCount: retryCount + 1,
          minimumBalanceRetryProvider: baseUrl,
        });

        retryResponse.initialTokenBalanceInSats = spendResult.tokenBalanceUnit === "msat"
          ? spendResult.tokenBalance / 1_000
          : spendResult.tokenBalance;
        retryResponse.initialTokenBalanceUnknown = spendResult.tokenBalanceUnknown;
        return retryResponse;
      }

      logger.warn(
        `[wallet] Could not reclaim the undersized xcashu token for ${baseUrl}; ` +
          `using the SDK's normal recovery and provider failover path.`,
      );
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
