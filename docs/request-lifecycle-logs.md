# Request lifecycle logs

Inference POSTs get one SDK-generated UUID, including malformed JSON, local validation errors, retries and provider failovers. Discovery, wallet, health and admin routes do not create lifecycle rows. Configured Bearer and `x-api-key` credentials resolve to a client ID at ingress; unrecognized clients are `unknown`. Credentials and model payloads are not lifecycle metadata.

```text
$ routstrd logs
alice - deepseek-v4.1-flash - 400 - 402 - 200 - 11111111-2222-4333-8444-555555555555
```

The SQLite lifecycle tables in `DB_PATH` are authoritative, independent of usage accounting and the optional raw request/response sink. Statuses come from actual attempts in ordinal order. Network failures show `NET`; requests without attempts show their local HTTP status or terminal outcome. A 200 status can still have a failed stream outcome; inspect verbose diagnostics.

```sh
routstrd logs -v
routstrd logs -i 11111111-2222-4333-8444-555555555555 -v
routstrd logs --client-id alice --model-id deepseek-v4.1-flash --outcome failed
routstrd logs -f -n 50
```

Verbose output interleaves chronological lifecycle events, attempt summaries and eligible correlated daemon/SDK diagnostics. It never opens the raw payload sink. Supplementary correlation searches retained daily daemon log files; lifecycle records remain available even after their flat logs are removed. Follow prints an updated summary when a request changes. `--before`/`--after` accept epoch milliseconds; `--base-url` filters by provider.

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
- `/usagePi` matches `upstreamResponseId ?? requestId`, retaining historical `gen-...` lookup while new usage rows use lifecycle UUIDs.

Premature client disconnect propagates cancellation to the SDK, rather than treating response headers as completion. A clean response finish does not cancel the request. Startup records a fresh daemon owner beside the database and reconciles only the previous daemon owner's unfinished requests as `interrupted`; unrelated SDK owners are untouched. This reconciliation runs after wallet startup acquires the existing process lock.

## SDK prerequisite

This feature requires the request-lifecycle SDK API (the parallel `feat/request-lifecycle-tracking` PR), not the currently released SDK 0.4.13. The package manifest intentionally retains its normal registry dependency; no local path or feature-branch dependency is shipped. Until that SDK API is released and the dependency updated, this is a dependent draft and clean-install build/typecheck are expected to fail on missing lifecycle exports. Local integration validation may use the SDK worktree build without changing the committed manifest or lockfile.
