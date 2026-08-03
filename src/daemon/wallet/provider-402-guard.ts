/**
 * Guard against funding a provider that a top-up cannot possibly help.
 *
 * A 402 from a Routstr provider has two very different meanings:
 *
 *   (a) *We* are short. The provider wants more sats on our API key:
 *       {"detail":{"error":{"message":"Insufficient balance: 19409.897 sats ...
 *                           required for this model; 9 sats ... available.",
 *                           "code":"insufficient_balance"}}}
 *       Topping up is correct and the request will succeed on retry.
 *
 *   (b) *They* are short. The provider's own upstream account is out of credit:
 *       {"error":{"message":"Insufficient credits. Add more using
 *                 https://openrouter.ai/settings/credits","code":402,
 *                 "metadata":{"limit_source":"openrouter_credits"}}}
 *       No amount of sats from us changes this. Every top-up mints a fresh
 *       token, hands it to a provider that still cannot serve the request,
 *       and relies on a refund that frequently fails ("proofs already spent").
 *
 * The SDK treats both as "top up and retry", which turns case (b) into an
 * unbounded drain: on 2026-07-30 two consecutive top-ups of 32480 and 6823
 * sats left the wallet in 1.5 seconds against a provider whose OpenRouter
 * credits were exhausted.
 *
 * This module classifies the 402 body and lets the top-up path refuse case (b)
 * outright, plus a rolling-window spend cap as a blunt backstop for any
 * pathology the classifier does not recognise.
 */

export type Provider402Kind =
  /** Our API-key balance is short — topping up is the correct response. */
  | "our_balance"
  /** The provider's own upstream credit is exhausted — topping up is pure loss. */
  | "provider_side"
  /** Unrecognised shape — treated as (a) so unknown providers keep working. */
  | "unknown";

/**
 * Classify a 402 response body.
 *
 * Deliberately asymmetric: `provider_side` requires a positive match, and
 * anything unrecognised falls back to `unknown` (which callers treat as
 * fundable). Refusing by default would break any provider whose 402 body we
 * have not seen, so the rolling cap — not the classifier — is what bounds the
 * damage in the unknown case.
 */
export function classifyProvider402(body: unknown): Provider402Kind {
  const text = typeof body === "string" ? body : safeStringify(body);
  if (!text) return "unknown";

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  // A `limit_source` naming an upstream account is the strongest signal that
  // the ceiling being hit belongs to the provider, not to us.
  const limitSource = findStringField(parsed, "limit_source");
  if (limitSource) return "provider_side";

  // `code: "insufficient_balance"` / `type: "insufficient_quota"` is the
  // Routstr-side shape and always refers to our own API-key balance.
  const code = findStringField(parsed, "code");
  const type = findStringField(parsed, "type");
  if (code === "insufficient_balance" || type === "insufficient_quota") {
    return "our_balance";
  }

  // Fall back to the message text. "credits" (theirs) vs "balance" (ours) is
  // the distinction the two providers actually draw.
  if (/insufficient\s+credits/i.test(text)) return "provider_side";
  if (/add\s+(more\s+)?credits/i.test(text)) return "provider_side";
  if (/insufficient\s+balance/i.test(text)) return "our_balance";

  return "unknown";
}

function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Recursively find the first string-valued occurrence of `field`. */
function findStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === field && typeof entry === "string" && entry.trim()) {
      return entry.trim();
    }
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const nested = findStringField(entry, field);
    if (nested) return nested;
  }
  return undefined;
}

// ── Rolling-window top-up cap ──────────────────────────────────────
//
// Backstop for anything the classifier misses. The first top-up in a window is
// always allowed, so a single genuinely expensive request still goes through;
// only the *cumulative* spend that follows it is capped.

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type Provider402GuardOptions = {
  windowMs?: number;
  windowCapSats?: number;
  now?: () => number;
};

export type TopUpDecision =
  | { allow: true }
  | { allow: false; reason: string };

export function createProvider402Guard(options: Provider402GuardOptions = {}) {
  const windowMs = options.windowMs ?? readEnvInt("ROUTSTRD_TOPUP_WINDOW_MS", 120_000);
  const windowCapSats =
    options.windowCapSats ?? readEnvInt("ROUTSTRD_TOPUP_WINDOW_CAP_SATS", 25_000);
  const now = options.now ?? (() => Date.now());

  /** baseUrl → most recent 402 body seen from that provider. */
  const last402Body = new Map<string, string>();
  /** baseUrl → top-ups recorded inside the current window. */
  const spend = new Map<string, Array<{ at: number; sats: number }>>();

  function prune(baseUrl: string): Array<{ at: number; sats: number }> {
    const cutoff = now() - windowMs;
    const kept = (spend.get(baseUrl) ?? []).filter((entry) => entry.at > cutoff);
    spend.set(baseUrl, kept);
    return kept;
  }

  return {
    /** Record the body of a 402 so the top-up path can consult it. */
    record402(baseUrl: string, body: unknown): void {
      if (!baseUrl) return;
      const text = typeof body === "string" ? body : safeStringify(body);
      last402Body.set(baseUrl, text);
    },

    /** Forget a provider's last 402 once it serves a request successfully. */
    clear(baseUrl: string): void {
      last402Body.delete(baseUrl);
      spend.delete(baseUrl);
    },

    /** Decide whether a top-up of `sats` to `baseUrl` should proceed. */
    evaluate(baseUrl: string, sats: number): TopUpDecision {
      const kind = classifyProvider402(last402Body.get(baseUrl));
      if (kind === "provider_side") {
        return {
          allow: false,
          reason:
            `provider ${baseUrl} reported its own upstream credit is exhausted; ` +
            `funding it cannot serve this request`,
        };
      }

      const recorded = prune(baseUrl);
      if (recorded.length > 0) {
        const cumulative = recorded.reduce((sum, entry) => sum + entry.sats, 0) + sats;
        if (cumulative > windowCapSats) {
          return {
            allow: false,
            reason:
              `top-up cap reached for ${baseUrl}: ${Math.round(cumulative)} sats within ` +
              `${Math.round(windowMs / 1000)}s exceeds the ${windowCapSats} sat limit`,
          };
        }
      }

      return { allow: true };
    },

    /** Record a top-up that actually went through. */
    recordTopUp(baseUrl: string, sats: number): void {
      if (!baseUrl || !Number.isFinite(sats) || sats <= 0) return;
      const kept = prune(baseUrl);
      kept.push({ at: now(), sats });
      spend.set(baseUrl, kept);
    },
  };
}

export type Provider402Guard = ReturnType<typeof createProvider402Guard>;
