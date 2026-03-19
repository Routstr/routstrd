# routstr Proxy Cost Logging Issue

## Problem

The routstr proxy at `localhost:8009` returns usage data that differs slightly from what the pi-ai `openai-completions` provider expects.

## What routstr Returns

**Streaming response (last chunk):**
```json
{
  "usage": {
    "prompt_tokens": 9,
    "completion_tokens": 9,
    "total_tokens": 18,
    "cost": 0.000018,
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "cache_write_tokens": 0
    },
    "completion_tokens_details": {
      "reasoning_tokens": 0
    }
  },
  "cost": {
    "total_usd": 0.000018
  }
}
```

## What pi-ai Expects

The `openai-completions` provider in pi-ai expects the standard OpenAI format:

```json
{
  "usage": {
    "prompt_tokens": 9,
    "completion_tokens": 9,
    "prompt_tokens_details": {
      "cached_tokens": 0
    },
    "completion_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
```

## Current Handling

The pi-ai provider already handles the standard format correctly via `parseChunkUsage()`:
- `input` ← `prompt_tokens - cached_tokens`
- `output` ← `completion_tokens + reasoning_tokens`
- `cacheRead` ← `prompt_tokens_details.cached_tokens`
- `cacheWrite` ← **NOT CURRENTLY PARSED** (hardcoded to 0)

The provider then calculates cost using `calculateCost()` based on the model's configured cost per million tokens, ignoring any `cost` field from the response.

## Gap

The `parseChunkUsage()` function in `packages/ai/src/providers/openai-completions.ts` does not currently extract:
1. `cache_write_tokens` from `prompt_tokens_details` (routstr-specific field)

Currently `cacheWrite` is hardcoded to 0.

## Resolution

The existing pi-ai `openai-completions` provider should work with routstr as-is since routstr returns the standard OpenAI format fields. The usage should be logged correctly if:
1. `stream_options: { include_usage: true }` is passed
2. The model has a `cost` configuration in the registry
