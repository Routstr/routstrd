/**
 * Request-path canonicalization for the proxied path.
 *
 * routstr-core reduces an incoming path to its allowlist key by stripping
 * exactly ONE optional leading `v1/` segment (`_canonical_api_path` in
 * `routstr/proxy.py`), then requires an exact match against its endpoint
 * table. Both `/chat/completions` and `/v1/chat/completions` therefore reach
 * the same handler, and no spelling with the prefix repeated ever does:
 * `/v1/v1/messages` canonicalizes to `v1/messages`, which is not an endpoint,
 * so the node answers `404 Path '/v1/v1/messages' not found`.
 *
 * That second prefix is not hypothetical — it is what an Anthropic-style
 * client produces when its base URL already ends in `/v1`, because the
 * Anthropic SDKs append `/v1/messages` themselves (the OpenAI SDKs append only
 * `/chat/completions` and leave the prefix to the configured base URL). One
 * such client turns every request into a paid upstream 404 on every provider in
 * the pool, so collapse the duplicate here, before any routing or payment
 * decision.
 */

/**
 * Collapse a repeated leading `/v1` segment to a single one.
 *
 * `/v1/v1/messages` and `/v1/v1/v1/messages` both become `/v1/messages`;
 * `/v1/messages`, `/chat/completions`, and every other spelling are returned
 * unchanged. Only the repeated `v1` segment is touched: the node owns the
 * endpoint allowlist, and rewriting anything else here would make this
 * ingress answer for paths it knows nothing about.
 *
 * Never throws and is idempotent: each pass shortens the path, so a path
 * that does not start with a doubled `/v1` is returned as-is.
 */
export function collapseDuplicatedV1(pathname: string): string {
  let path = pathname;
  while (path.startsWith("/v1/v1/") || path === "/v1/v1") {
    path = path.slice(3);
  }
  return path;
}

/**
 * Endpoints a provider node forwards, in the canonical spelling that omits
 * `v1/`.
 *
 * Mirrors `_ALLOWED_ENDPOINTS` in routstr-core's proxy: the node reduces a
 * request path to one of these keys after stripping exactly one optional
 * `v1/`, and forwards anything else to no one. Kept as a local list for the
 * same reason as `OPENAI_JSON_BODY_PATH_SUFFIXES` in `request-body.ts` —
 * routstrd must not version a path it does not recognise, because a routstr
 * node is not the only possible destination for a forwarded request.
 */
const FORWARDED_ENDPOINTS = new Set([
  "chat/completions",
  "completions",
  "responses",
  "messages",
  "messages/count_tokens",
  "embeddings",
  "systemone",
]);

/**
 * Ensure a forwarded API path carries the `/v1` prefix.
 *
 * The node accepts an endpoint with or without `v1/` (`_canonical_api_path`)
 * and forwards the caller's spelling to its own upstream, so the spelling is
 * not free: an upstream whose base URL carries no version prefix serves only
 * the versioned route. Tinfoil is one — a bare `/chat/completions` reached
 * `https://inference.tinfoil.sh/chat/completions` and came back
 * `404 {"error":{"message":"Not found."}}`, while the same request with the
 * prefix succeeded. A client cannot know which upstream sits behind a node, so
 * routstrd sends the versioned spelling that every provider in the pool
 * accepts.
 *
 * Applied to the forwarded path only — never to `url.pathname`, which the
 * ingress still matches its own routes against — and only to the endpoints
 * above. Idempotent, so a client that already sends `/v1/...` is unaffected;
 * a query string and a trailing slash are preserved.
 */
export function ensureV1Prefix(pathname: string): string {
  const [path = ""] = pathname.split("?");
  if (path.startsWith("/v1/")) return pathname;
  const endpoint = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!FORWARDED_ENDPOINTS.has(endpoint)) return pathname;
  return `/v1${pathname}`;
}
