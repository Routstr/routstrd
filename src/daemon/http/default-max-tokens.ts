/**
 * Give completion requests a bounded output length when the client omits one.
 *
 * A provider cannot know how long a response will be, so when `max_tokens` is
 * absent it must reserve the worst case: the model's entire context window
 * billed at its completion rate. For an expensive model that reservation
 * dwarfs the actual cost of the request.
 *
 * Measured 2026-07-31 against a wallet holding 8,557 sats:
 *
 *   glm-5.2  completion 2.277e-06/tok, 1M context → reserve  ~2,790 sats → served
 *   kimi-k3  completion 1.125e-05/tok, 1M context → reserve ~13,715 sats → rejected
 *
 * Same wallet, same code path — only the price per output token differed. The
 * identical kimi-k3 request succeeded immediately with `max_tokens: 16`.
 *
 * Clients that care about output length send `max_tokens` and are left
 * untouched. Clients that omit it get a cap instead of a reservation they
 * cannot afford, which fails the request outright.
 */

const DEFAULT_MAX_TOKENS = 8192;

/** Paths where `max_tokens` is meaningful. */
const COMPLETION_PATH = /\/(chat\/)?completions$/;

export function resolveDefaultMaxTokens(): number | null {
  const raw = process.env.ROUTSTRD_DEFAULT_MAX_TOKENS;
  if (raw === undefined) return DEFAULT_MAX_TOKENS;

  const trimmed = raw.trim().toLowerCase();
  // An explicit opt-out restores verbatim forwarding.
  if (trimmed === "" || trimmed === "0" || trimmed === "off" || trimmed === "false") {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
}

export function isCompletionPath(path: string): boolean {
  return COMPLETION_PATH.test(path);
}

/**
 * Return the body to forward, plus the value injected (if any).
 *
 * The body is only modified when every one of these holds: the path is a
 * completion endpoint, the caller set neither `max_tokens` nor the newer
 * `max_completion_tokens`, and the default has not been disabled.
 */
export function applyDefaultMaxTokens(
  body: Record<string, unknown>,
  path: string,
  defaultMaxTokens: number | null = resolveDefaultMaxTokens(),
): { body: Record<string, unknown>; injected: number | null } {
  if (defaultMaxTokens === null) return { body, injected: null };
  if (!isCompletionPath(path)) return { body, injected: null };
  if (!body || typeof body !== "object") return { body, injected: null };

  // Respect an explicit choice, including an explicit null meaning "unbounded".
  if ("max_tokens" in body && body.max_tokens !== undefined) {
    return { body, injected: null };
  }
  if ("max_completion_tokens" in body && body.max_completion_tokens !== undefined) {
    return { body, injected: null };
  }

  return {
    body: { ...body, max_tokens: defaultMaxTokens },
    injected: defaultMaxTokens,
  };
}
