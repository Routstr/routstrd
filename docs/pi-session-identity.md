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

At inference ingress Routstrd reads `x-session-id`, `session-id`, `session_id`,
`x-session-affinity`, and `x-opencode-session` for usage accounting, in that
precedence order. Header names are case-insensitive. Top-level `session_id`,
`sessionId`, and `prompt_cache_key`, plus metadata `session_id`/`sessionId`,
are fallback sources. `x-client-request-id` is not used for accounting:
callers may send a unique value per request. Only nonempty values of at most
256 characters without control characters are stored. These headers and
fields are untrusted client labels, not authentication.

Reading session identity does not change the request passed to the SDK router.
The pinned SDK (0.5.2) forwards these session headers to the selected provider,
and it also forwards body fields such as `prompt_cache_key`. A client that puts
its session ID in that field allows the upstream provider to see it.
Caller-provided cache affinity is preserved; this feature does not anonymize
requests. The forwarded headers are a fixed allowlist (`x-session-id`,
`session-id`, `session_id`, `x-session-affinity`, `x-opencode-session`,
`x-client-request-id`); credentials, cookies and any other header are never
forwarded.

The request-scoped usage driver adds the selected ID to local accounting rows
without changing the shared driver. `GET /usage` omits the stored session ID.
Request logs, when enabled, may contain session metadata. Historical rows are
not backfilled, and no new schema is needed.
