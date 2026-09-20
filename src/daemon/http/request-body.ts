/**
 * Request-body shaping for the proxied path.
 *
 * The ingress forwards the caller's JSON body to the upstream provider. It is
 * allowed to add exactly one thing — a default output-token limit — and only
 * where that field is part of the endpoint's documented vocabulary. Anything
 * else must be forwarded verbatim: several upstreams (notably TypeSafe's
 * `POST /v1/systemone`) validate strictly and reject unknown fields, so an
 * injected chat-completions field turns a valid request into an opaque
 * `400 Invalid request.`
 */

/**
 * OpenAI-compatible endpoints whose bodies define `max_tokens`,
 * `max_output_tokens`, and `stream`.
 *
 * Matched by path suffix so `/v1/chat/completions`, `/chat/completions`, and
 * custom path-prefixed proxies all qualify. Kept in sync with
 * `isOpenAiJsonBodyPath` in `@routstr/sdk` (exported there since 0.4.6); once
 * routstrd depends on that version this local copy can be dropped.
 */
export const OPENAI_JSON_BODY_PATH_SUFFIXES = [
  "/chat/completions",
  "/completions",
  "/responses",
] as const;

/**
 * True when `pathname` addresses an endpoint whose body carries the OpenAI
 * request vocabulary. Ignores a query string and a trailing slash.
 */
export function isOpenAiJsonBodyPath(pathname: string): boolean {
  const path = (pathname.split("?")[0] ?? "").replace(/\/+$/, "");
  return OPENAI_JSON_BODY_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/**
 * Cap the completion budget when the client does not set an output token
 * limit. Without this, the SDK prices at the provider's worst-case
 * `max_completion_cost`, which varies widely across providers (2.3× for
 * kimi-k3) and balloons during provider failover. Chat/completions use
 * `max_tokens`; the OpenAI Responses API uses `max_output_tokens`.
 *
 * Non-OpenAI endpoints are left untouched — `/v1/systemone` returns typed
 * judgments rather than generated text, so it has no completion budget, and it
 * rejects the field outright. Mutates `body` in place. Returns true when a
 * field was added.
 */
export function applyDefaultOutputTokenLimit(
  pathname: string,
  body: Record<string, unknown>,
  maxTokens: number,
): boolean {
  if (!(maxTokens > 0) || !isOpenAiJsonBodyPath(pathname)) {
    return false;
  }

  if (pathname.split("?")[0]!.replace(/\/+$/, "").endsWith("/responses")) {
    if (typeof body.max_output_tokens === "number") return false;
    body.max_output_tokens = maxTokens;
    return true;
  }

  if (typeof body.max_tokens === "number") return false;
  body.max_tokens = maxTokens;
  return true;
}
