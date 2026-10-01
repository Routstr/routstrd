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
