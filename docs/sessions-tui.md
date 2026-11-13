# Sessions in the usage monitor

Run `bun src/index.ts monitor` (or `routstrd monitor` after building). Sessions
is immediately before Recent. Use left/right or its displayed numeric shortcut.

- Up/down selects a session; Enter opens detail; Escape returns to the list.
- `/` filters the loaded page by first prompt, working directory, or ID.
- `M` loads 20 more, up to 200; `R` refreshes. Auto-refresh loads at most every
  ten seconds while this tab is active. Detail uses the monitor's normal scroll keys.
- Titles are the first user message's text, whitespace normalized. Project is
  the basename of the transcript header's cwd; details retain the full path.
- Spend is **sats only**. Unknown prices are not zero; partial totals are marked.
  Missing/ambiguous joins remain in an explicit Unknown attribution bucket.

Data is local to the monitor machine, even when monitoring a remote daemon:
`~/.pi/agent/sessions/*/*.jsonl` and read-only `$ROUTSTRD_DIR/routstr.db`
(default `~/.routstrd/routstr.db`). No request/response payload logs are read.
Response IDs join to `coalesce(nullif(upstream_response_id,''),request_id)`;
legacy schemas fall back to request_id. Ambiguous keys are not priced; repeated
transcript IDs are priced once. Provider means the recorded inference provider,
not the Routstr node URL.

Cache misses follow Pi core session totals: prompt = input + cacheRead +
cacheWrite; miss = min(previous prompt,current prompt) - current cacheRead.
Only misses strictly above 1,024 tokens count, and caching must have been
reported in this scan segment. First turns do not count. Compaction/branch
summary reset the baseline; cache-warm entries update it; model/provider switches
and positive-usage errors participate. Each event is assigned to the current
request's node/provider after calculating in transcript order. These are
**estimates assuming an unchanged prefix**, not prompt-content comparisons.
A dash means there were no eligible comparisons, not a proven zero misses.

For safety, discovery orders candidates by modification time and sorts the
loaded page by latest transcript timestamp. Copied/touched files can therefore
change which page a session appears on. Parsing happens in a worker, streams
64 KiB chunks, skips lines over 2 MiB and stops at 32 MiB / 5,000 assistant
entries per transcript. A page stops after roughly 20,000 assistant entries.
Truncation/malformed data is warned about; malformed gaps reset the heuristic
baseline conservatively. Filter only searches loaded sessions. These deliberate
bounds favor a responsive monitor over exhaustive historical reporting.

## Runtime regression checks

Run `systemd-run --user --scope -q -p MemoryMax=768M -p MemorySwapMax=0 bash scripts/check-sessions-worker.sh`
to exercise worker startup in source, bundled, and compiled-executable modes.
The check creates a temporary HOME with one synthetic Pi transcript and verifies
that a missing accounting database is not created. Compiled workers use Bun's
embedded `tui/usage/sessions-worker.js` entry, not a sibling of the main executable.
The TUI test suite also executes an isolated full-app key-dispatch harness for
Sessions details → `/` and `?` → Escape → tab switch / refresh / quit.

### Session request table

Session details reuse Recent's request table directly: the same TIME, MODEL,
CACHE HIT bar, IN/OUT, COST (sats), BASE:PROVIDER and CLIENT layout and formatting.
Requests are newest first and scoped to that transcript; unlike Recent's 50-row
preview, details include all requests within the loader's existing safety bounds.
The monitor's existing line/page/Home/End scrolling applies. Recent has no row
selection or request drill-down, so Sessions does not invent one. At narrow widths,
columns are clipped with the same priority as Recent; full node/provider statistics
remain above the table. Unknown prices/tokens display a dash, and an explicit
accounting-gap list below the table preserves transcript-only, ambiguous and
repeated-ID entries. Estimated miss-event annotations remain separate from the
shared table. `/` and `?` do not activate global request search inside details.

### Recent cache-miss estimates

Recent now starts the same bounded worker in the background without requiring a
visit to Sessions. The first 20 loaded recent sessions supply canonical Pi
session-sequence estimates. Only eligible unique exact response-ID matches are
attached to Recent requests (`upstreamResponseId`, or legacy `requestId`). Missing,
ambiguous, first-turn, unsupported-cache and incomplete-transcript matches remain
unknown. Requests from different sessions never become each other's predecessor.
Coverage below Recent counts eligible exact matches; blue means uncached with no
identified miss, **not** proof of a zero miss. The estimate index is rebuilt on
worker results, throttled to ten seconds and refreshed explicitly with R; estimates
are withheld while refreshing. Repeated refreshes queue one follow-up worker pass.
Remote/auth-proxy monitoring disables local transcript estimates entirely, to avoid
mixing local Pi history with another daemon's accounting. No payload logs are used.

Sessions presentation excludes an assistant attempt only if Pi explicitly records
`stopReason: error` or `aborted`, all recorded prompt buckets and output tokens
are zero, and the response has no matching accounting row. Unknown token usage,
positive-usage failures, matched accounting (even zero-priced), ambiguous joins,
and ordinary unmatched successes remain visible. A short excluded-attempt count
appears in details. Filtering is after canonical cache scanning, so positive-usage
errors still participate in Pi predecessor semantics; Recent is unchanged.
