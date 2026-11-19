# Local Pi session identity

Installing/refreshing the Pi integration sets Routstr provider compatibility to
`sendSessionAffinityHeaders: true` and `sessionAffinityFormat: "openrouter"`.
For supported Pi OpenAI transports this sends the dynamic Pi session ID in
`x-session-id`; the format name does not change the provider endpoint. Existing
model overrides of those two managed fields are updated too. Other compatibility
settings, including DeepSeek's developer-role override, are preserved.

Transport caveats: Pi's completions transport does not send affinity headers
when cache retention is `none`. This setting does not guarantee that Pi's
Anthropic transport sends a session header.

At inference ingress Routstrd consumes `x-session-id`, `session-id`, `session_id`,
`x-session-affinity`, and `x-opencode-session` locally, in that precedence order.
Header names are case-insensitive. Top-level `session_id`, `sessionId`, and
`prompt_cache_key`, plus metadata `session_id`/`sessionId`, are fallback sources.
`x-client-request-id` is stripped but not used for accounting: callers may send
one unique value per request. Only nonempty values of at most 256 characters
without control characters are stored. These identifiers are untrusted client
labels, not authentication.

Before invoking the SDK router, all those header aliases and body fields are
removed (including metadata `prompt_cache_key`). The request-scoped usage driver
adds the selected ID to locally appended accounting rows, without changing the
shared driver or unrelated requests. `GET /usage` omits the stored session ID.
No session ID is inferred from an upstream response or injected into upstream requests. In particular, a caller's explicit
`prompt_cache_key` no longer reaches upstream; this sacrifices that explicit
cache-affinity hint for local conversation privacy. Automatic prefix caching is
not disabled by this policy.

This is not payload anonymization: prompt text, arbitrary user-defined metadata,
and unrelated identifiers are not recursively searched or rewritten. Request
logs, when explicitly enabled, may still contain the original local request.
Historical accounting rows are not backfilled. No new schema is needed: the SDK
usage entry and SQLite driver already support `sessionId` / `session_id`.
