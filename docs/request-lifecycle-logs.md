# Request lifecycle logs

Inference POSTs get one SDK-generated UUID, including malformed JSON, local validation errors, retries and provider failovers. Discovery, wallet, health and admin routes do not create lifecycle rows. Configured Bearer and `x-api-key` credentials resolve to a client ID at ingress; unrecognized clients are `unknown`. Credentials and model payloads are not lifecycle metadata.

```text
$ routstrd logs
15:57:03  alice - deepseek-v4.1-flash - 400 - 402 - 200 - 11111111-2222-4333-8444-555555555555
```

Summaries lead with the request's start time, in UTC, as time of day only: the covering daily log file already names the date, and a fixed-width clock keeps pasted output comparable across machines and time zones.

The SQLite lifecycle tables in `DB_PATH` are authoritative, independent of usage accounting and the optional raw request/response sink. Statuses come from actual attempts in ordinal order. Network failures show `NET`; requests without attempts show their local HTTP status or terminal outcome. A 200 status can still have a failed stream outcome; inspect verbose diagnostics.

```sh
routstrd logs -v
routstrd logs -i 11111111-2222-4333-8444-555555555555 -v
routstrd logs --client-id alice --model-id deepseek-v4.1-flash --outcome failed
routstrd logs -f -n 50
```

`-n` defaults to `7` and is capped at `1000`, for both lifecycle summaries and `--raw` lines.

Verbose output interleaves chronological lifecycle events, attempt summaries and eligible correlated daemon/SDK diagnostics. It never opens the raw payload sink. Supplementary correlation searches retained daily daemon log files; lifecycle records remain available even after their flat logs are removed. Follow prints an updated summary when a request changes. `--before`/`--after` accept epoch milliseconds; `--base-url` filters by provider.

### Following in-flight requests

`-n` bounds the initial window, but it does not bound what follow keeps watching. A request that is still `in_progress` is re-read by ID on later polls even after newer requests push it out of the newest-`-n` window, so its final status is always reported. IDs are dropped as soon as their outcome is terminal, and at most 100 are carried at once, so a request stuck in `in_progress` cannot grow the per-poll cost without limit.

A stream cannot rewrite a line it has already printed, so an update is appended at the point the change was observed, not at the request's start position. Re-renders therefore carry an `(updated)` marker on their summary line, which distinguishes a completed request from a second, newer request sitting at an older timestamp:

```text
02:59:47  pi-agent - deepseek-v4.1-flash-1017 - IN_PROGRESS - 4b908851-2df8-47e5-b99a-f07e6026b14d
02:59:47  pi-agent - deepseek-v4.1-flash-1017 - 200 - 4b908851-2df8-47e5-b99a-f07e6026b14d  (updated)
```

Legacy behavior remains available explicitly:

```sh
routstrd logs --raw -n 100
routstrd logs --raw -f
routstrd logs --raw -r
routstrd logs --raw -i <request-id>
routstrd logs --coco -f
```

Raw flat logs can contain sensitive diagnostics. `-v` is not permission to expose payloads.

## HTTP API and compatibility

- `GET /requests?limit=50&before=<ms>&after=<ms>&outcome=failed&modelId=<model>&baseUrl=<provider>&clientId=alice` returns `{ output: [...] }`, newest first.
- `GET /requests/<full-uuid>` returns `{ request, attempts, events }`, with ordinal/sequence ascending; unknown IDs return 404.
- Inference responses, including local rejection responses, include `x-routstr-sdk-request-id`. The node's existing `x-routstr-request-id` is preserved and identifies a different object: the final node attempt.

Premature client disconnect propagates cancellation to the SDK, rather than treating response headers as completion. A clean response finish does not cancel the request. Startup records a fresh daemon owner beside the database and reconciles only the previous daemon owner's unfinished requests as `interrupted`; unrelated SDK owners are untouched. This reconciliation runs after wallet startup acquires the existing process lock.

## SDK prerequisite

This feature requires `@routstr/sdk` 0.5.0 or newer (routstrd 0.5.1 pins 0.5.1), which ships the request-lifecycle API (`RequestLifecycleDriver`, `createBunSqliteRequestLifecycleDriver`). The dependency is the normal registry version; no local path or feature-branch dependency is shipped.
