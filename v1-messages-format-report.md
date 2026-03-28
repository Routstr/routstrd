# Report: why `POST /v1/messages` on port 8008 returns chat-completions chunks while port 8009 preserves Messages API format

Date: 2026-03-28

## Summary

I tested the same request against both local daemons using `scripts/test-direct-local.ts` semantics (`POST /v1/messages`, `stream: true`).

- `localhost:8009` preserves the Anthropic/OpenAI Messages-style stream as expected:
  - `message_start`
  - `content_block_start`
  - `content_block_delta`
  - `message_delta`
  - `message_stop`
- `localhost:8008` returns OpenAI chat-completions streaming chunks instead:
  - `object: "chat.completion.chunk"`
  - `choices[].delta`

This is **not** because the SDK itself is incapable of preserving `/v1/messages`.
It happens because the two daemons call the SDK differently.

---

## What I tested

### 8008 (`../routstrd/`)

Listener:
- `../routstrd/src/daemon/index.ts`
- request handler in `../routstrd/src/daemon/http/index.ts`

Observed result for `POST http://localhost:8008/v1/messages`:
- response `content-type: text/event-stream`
- SSE payload is OpenAI chat-completions chunks (`chat.completion.chunk`)

### 8009 (`routstr-chat/scripts/routstr-daemon.ts`)

Listener:
- `scripts/routstr-daemon.ts`

Observed result for `POST http://localhost:8009/v1/messages`:
- response `content-type: text/event-stream`
- SSE payload preserves Messages API events (`message_start`, `content_block_delta`, etc.)

---

## Direct cause

### 8009 forwards the incoming path to the SDK

In `routstr-chat/scripts/routstr-daemon.ts`, the request is routed with:

```ts
await routeRequestsToNodeResponse({
  modelId,
  requestBody,
  path: url.pathname,
  headers: forwardedHeaders,
  ...
});
```

Because it passes:

```ts
path: url.pathname
```

an incoming request to `/v1/messages` stays `/v1/messages` all the way through the SDK and upstream provider routing.

### 8008 does **not** forward the incoming path

In `../routstrd/src/daemon/http/index.ts`, the request is routed with:

```ts
const response = await routeRequests({
  modelId,
  requestBody,
  forcedProvider,
  headers: incomingHeaders,
  walletAdapter: deps.walletAdapter,
  storageAdapter: deps.storageAdapter,
  providerRegistry: deps.providerRegistry,
  discoveryAdapter: deps.discoveryAdapter,
  modelManager: deps.modelManager,
  debugLevel: "DEBUG",
  mode: deps.mode,
  usageTrackingDriver: deps.usageTrackingDriver,
  sdkStore: deps.store,
});
```

Notice: **no `path` is passed**.

In the SDK, `routeRequests()` defaults the path to:

```ts
path = "/v1/chat/completions"
```

from:
- `routstr-chat/sdk/routeRequests.ts`

So even when the client calls:

```http
POST /v1/messages
```

on port 8008, the daemon internally re-routes it as:

```http
POST /v1/chat/completions
```

That is why the upstream/provider response is converted into chat-completions format.

---

## Why the behavior differs even though both are built on the same SDK

Both daemons use the same SDK primitives, but:

- **8009** uses `routeRequestsToNodeResponse(...)` and explicitly passes `path: url.pathname`
- **8008** uses `routeRequests(...)` and relies on the SDK default path, which is `/v1/chat/completions`

So the format difference is caused by **daemon integration code**, not by a provider-specific quirk and not by an unavoidable SDK conversion.

---

## Important implementation detail

The SDK helper itself documents this default:

- `routstr-chat/sdk/routeRequests.ts`

```ts
/** Optional: API path (defaults to /v1/chat/completions) */
```

and in `resolveRouteRequestContext(...)`:

```ts
path = "/v1/chat/completions"
```

Therefore any caller that omits `path` will get chat-completions semantics by default.

---

## Evidence from runtime tests

### Port 8008

Observed streamed chunks included:

- `object: "chat.completion.chunk"`
- `choices[0].delta.content`
- final `[DONE]`

### Port 8009

Observed streamed events included:

- `event: message_start`
- `event: content_block_start`
- `event: content_block_delta`
- `event: message_delta`
- `event: message_stop`
- final `[DONE]`

This matches the code-path difference above.

---

## Recommended fix

In `../routstrd/src/daemon/http/index.ts`, pass the incoming path through to the SDK:

```ts
const response = await routeRequests({
  modelId,
  requestBody,
  path: url.pathname,
  forcedProvider,
  headers: incomingHeaders,
  walletAdapter: deps.walletAdapter,
  storageAdapter: deps.storageAdapter,
  providerRegistry: deps.providerRegistry,
  discoveryAdapter: deps.discoveryAdapter,
  modelManager: deps.modelManager,
  debugLevel: "DEBUG",
  mode: deps.mode,
  usageTrackingDriver: deps.usageTrackingDriver,
  sdkStore: deps.store,
});
```

This should make `POST /v1/messages` on port 8008 preserve the Messages API format, matching port 8009.

---

## Secondary note

Port 8008 currently uses `routeRequests(...)` and then manually streams the returned response body to `res`.
Port 8009 uses `routeRequestsToNodeResponse(...)` directly.

That difference is probably not the root cause here.
The root cause is specifically that **8008 drops the incoming request path and falls back to the SDK default of `/v1/chat/completions`**.

---

## Conclusion

The reason `localhost:8008/v1/messages` appears to "convert to chat completions" is:

1. `../routstrd` receives `/v1/messages`
2. its handler calls `routeRequests(...)` without `path`
3. the SDK defaults `path` to `/v1/chat/completions`
4. the upstream request is therefore made against chat completions
5. the stream returned is chat-completions SSE, not Messages API SSE

Port 8009 works because it explicitly forwards `url.pathname` into the SDK call.
