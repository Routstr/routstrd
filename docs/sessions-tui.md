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

Sessions hides ordinary failed-attempt rows only when Pi explicitly records
`stopReason: error` or `aborted`, recorded prompt buckets and output are all zero,
and no accounting row matches. Hidden does **not** mean unbilled: timeout,
disconnect/reset, upstream 502, abort, terminated and other failures remain in
accounting denominators, retain `+?`, and produce a concise “N failed attempts;
spend unknown” warning. Their normal request rows/node groups stay hidden.

Only a narrow local pre-send module-loader signature is excluded from coverage:
an error with no response ID matching exactly “Cannot find module” / “Cannot import
module” with an absolute path to `@earendil-works/pi-ai` or `@mariozechner/pi-ai`
`dist/providers/openai-responses.js` (or src/ts), optionally with an absolute
“imported from” path. Generic local-looking text, wrapped upstream messages and
other import failures are **not** classified as pre-send. Unrecognized loader
formats intentionally retain unknown-spend coverage rather than claiming certainty.

Positive usage, matched accounting (even zero-priced), ambiguous joins, unknown
usage and ordinary unmatched successes remain visible. Filtering happens after
canonical cache scanning. Recent's accounting rows and estimate matching are unchanged.

## Additional Pi / Bunkhouse transcript sources

The monitor also reads optional `sessionSources` from
`$ROUTSTRD_DIR/config.json` (default `~/.routstrd/config.json`). Merge this section
into your existing config; **do not replace other settings**:

```json
{
  "sessionSources": [
    {
      "path": "/home/user/projects/nostr/bunkhouse/state/assistant/pi/main/sessions",
      "kind": "bunkhouse",
      "label": "Bunkhouse · assistant · main"
    },
    {
      "path": "/home/user/projects/nostr/bunkhouse/state/assistant/pi/main-2/sessions",
      "kind": "bunkhouse",
      "label": "Bunkhouse · assistant · main-2"
    }
  ]
}
```

These are example paths for this checkout, not built-in search locations. Use
absolute paths (or `~/...`) to **exact flat directories** containing `.jsonl`
files. Add each group explicitly; no home/project recursion or automatic state
root search occurs. `kind: "pi"` supports other custom Pi transcript directories
without changing their first-user-message title. `kind: "bunkhouse"` extracts the
first actual `<message ...>` body after the framing context, including multiline
text parts; missing framing displays a placeholder instead of exposing context.

The label appears in the Project column for custom sources and as a separate
Source line in details. The recorded cwd remains unchanged and visible in
Project details; the label is not an inferred repository name. Without a label,
Bunkhouse uses `Bunkhouse · <group-directory>`. Filtering includes source labels.

Press **R** to reload sources/config. Both Sessions and Recent's asynchronous
cache-miss lookup use this same source set without needing to visit Sessions.
All candidates merge before the existing 20-session initial limit (200 max).
Overlapping/symlink directories and files are deduplicated. Duplicate session IDs
show the newest copy once with a warning; their cache estimates are withheld from
Recent rather than choosing ambiguous history. Missing sources warn without
preventing other sources from loading. Remote Recent monitoring still does not
use local transcript estimates.

Discovery caps: 100 configured sources, 1,000 directories, and 50,000 directory
entries; capped discovery warns that results are incomplete. Existing streamed
transcript/turn limits, read-only accounting, and worker isolation remain intact.
No live config is changed by installing this feature. Source config errors never
include the config contents or credentials in the UI.
