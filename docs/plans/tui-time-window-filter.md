# TUI time-window filtering

> **Status:** scoped, not started. Worktree: `.worktrees/tui-time-window-filter`
> (branch `feat/tui-time-window-filter`, based on `main` @ `7c53ebc`).

## Goal

Let the usage monitor show its stats for a selectable time window —
**All / Today (24h) / 7 days / 30 days** — on every tab that aggregates
history:

| Tab       | Filtered? | Notes                                            |
| --------- | --------- | ------------------------------------------------ |
| Overview  | no        | stays all-time, as requested                      |
| Today     | n/a       | already a fixed "today" view                      |
| Models    | **yes**   |                                                   |
| Providers | **yes**   |                                                   |
| Tokens    | **yes**   | totals + by-model + size buckets                  |
| Clients   | **yes**   | incl. top-models-per-client                       |
| Npubs     | **yes**   | incl. top-models-per-npub                         |
| Recent    | no        | last 50 requests, as requested                    |

## Feasibility: high

The hard part already exists. The SDK's `UsageTrackingDriver`
(`node_modules/@routstr/sdk/storage/usageTracking/interfaces.ts`) accepts
`after` / `before` timestamps on **all three** read paths:

- `list({ after, before, ... })`
- `count({ after, before, ... })`
- `aggregate({ after, before, groupBy, ... })`

The SQLite/Bun drivers push `WHERE timestamp > ?` down (indexed via
`idx_<table>_timestamp`), and the in-memory driver filters in JS, so both
backends behave identically. `aggregate` already does tz-aware `day`/`hour`
bucketing.

`/usage/summary` (`src/daemon/http/index.ts` ~L1943) → `getUsageSummary`
(`src/daemon/http/usage-summary.ts`) is the single producer of everything the
TUI renders. So filtering is **plumbing + UI**, not new data modelling.

Rejected alternative: filter client-side from raw entries. The TUI only
receives `recent` (50 rows); doing aggregates in the TUI would require
shipping the whole table over HTTP on every 2s refresh. Not viable at scale.

## Recommended design

### 1. Backend — additive, backwards-compatible

Extend `getUsageSummary` with a window and, instead of mutating the existing
all-time fields, add a **parallel windowed block**:

```ts
type TimeWindow = "all" | "today" | "7d" | "30d";

interface WindowedStats {
  totals: StatRow;
  models: ModelSummary[];
  providers: ProviderSummary[];
  clients: ClientSummary[];   // with topModels
  npubs: NpubSummary[];       // with topModels
  sizeBuckets: UsageSummary["sizeBuckets"];
}

interface UsageSummary {
  // ...existing all-time fields, untouched...
  days: DaySummary[];         // unchanged (last 30d, drives Today tab)
  hoursToday: HourSummary[];  // unchanged (drives Today tab)
  recent: UsageTrackingEntry[]; // unchanged (drives Recent tab)
  window?: WindowedStats;     // NEW, only when ?window= is requested
}
```

Why a separate block instead of reusing `totals`/`models`/...?

- Overview is excluded from filtering and reads `totals`/`models`/`clients`.
  If we windowed those in place, Overview would silently change. Keeping the
  top level **all-time** means Overview/Recent/Today are byte-for-byte
  unchanged, and other `/usage/summary` consumers keep working.
- The filtered tabs read `summary.window.*`; Overview reads `summary.*`.

`getUsageSummary` signature becomes roughly:

```ts
getUsageSummary(driver, clients, tzOffsetMinutes, clientFilter?, window: TimeWindow = "all")
```

and the window is translated to `after`:

- `today` → start of local day (reuse `startOfLocalDayUtc`)
- `7d`  → `now - 7 * 86400000`
- `30d` → `now - 30 * 86400000`
- `all` → no `after`

`after` is merged into `baseFilter` for the *windowed* aggregate/list/count
calls only. Module memo cache key gains the window (cache currently keyed on
`count:clientIdentity:tz[:filter]`).

HTTP: `GET /usage/summary?tz=…&window=7d[&npub=…]`. Unknown/missing `window`
→ omit the `window` block (current behaviour preserved).

### 2. TUI state & data

- Add `TimeWindow` to `src/tui/usage/types.ts`; extend `UsageStats` with the
  windowed block (or keep a small `stats.window` accessor).
- `fetchUsageSummary(window)` sends `&window=<id>`.
- Keep a small in-memory cache `Map<TimeWindow, UsageStats>` in `app.ts` so
  switching windows renders instantly and the 2s auto-refresh only refreshes
  the **active** window. Dispatch the request immediately on window change
  instead of waiting for the next tick; keep showing the previous paint until
  the new one lands.
- Overview/Recent keep reading the all-time block.

### 3. TUI keys & chrome

Number keys `1`–`8` are the tabs, so the window gets its own key(s). Free
keys: `w`, `t`, `d`, `s`, `b`, `[`, `]`, …

Simplest, least-surprising proposal:

- **`w`** cycles `All → Today → 7d → 30d` (and `W` cycles backwards).
- Optional direct keys later: `t` = Today, `d` = 7d, `o` = 30d.
- Render an always-visible selector in the header/tab row, e.g.
  `window: [All] 24h 7d 30d`, with the active one highlighted (reuse the tab
  highlight style). The selector is dimmed/hidden on Overview and Recent
  (or shown but marked `n/a`) so it's obvious where it applies.
- Footer hint: `[W] window`.

Empty states already exist ("No model data available"); they now correctly
mean "none in this window".

## Files touched

Backend
- `src/daemon/http/usage-summary.ts` — `TimeWindow`, windowed block, `after`
  threading, cache key.
- `src/daemon/http/index.ts` — parse `?window=`, pass through.
- `src/daemon/http/usage-summary.test.ts` — window cases (new).

TUI
- `src/tui/usage/types.ts` — `TimeWindow`, extend `UsageStats`.
- `src/tui/usage/data.ts` — `fetchUsageSummary(window)`.
- `src/tui/usage/app.ts` — window state, per-window cache, key handling,
  header wiring, immediate refetch.
- `src/tui/usage/render.ts` — filtered tabs read `summary.window.*`; header
  shows the selector.
- `src/tui/usage/render.test.ts` — update fixtures / add selector assertions.

Docs (optional): `README.md` / `SKILL.md` mention `[W]`.

## Risks / edge cases

- **Cache invalidation** — the summary memo must key on the window, else a 7d
  request can serve an all-time (or 30d) cached summary.
- **`days` / `hoursToday` / `recent`** stay all-time so the Today and Recent
  tabs are unaffected. Do not window them.
- **Boundary semantics** — driver uses `timestamp > after` (strict). "Today"
  should reuse `startOfLocalDayUtc` so it matches the `day` bucketing; a
  request exactly *at* local midnight would be excluded, which already is the
  behaviour of the `hoursToday` query (`after: todayStartUtc - 1`).
- **Query cost** — each request now does all-time aggregates **plus** one
  windowed set (~2× the current ~12 queries). The 60s daemon cache plus
  per-window TUI cache keeps the 2s tick cheap; only the active window is
  recomputed. If it ever matters, compute the window block lazily only when
  the active tab needs it.
- **`sizeBuckets`** is computed in JS from a full `list()`; with `after` it is
  bounded to the window — a bonus, not a problem.
- **Percentages** — `renderModels`/`renderClients`/`renderNpubs` divide by
  `stats.totalSatsCost` (all-time). When windowed they must divide by the
  window's total, or the percentages won't sum to 100%.
- **Overview is untouched** — verify by rendering both with `window=all` and
  `window=7d` and diffing the Overview output.

## Verification

- `bun test src/daemon/http/usage-summary.test.ts` — new window fixtures.
- `bun test src/tui/usage/render.test.ts`.
- `bun run lint` (tsc --noEmit).
- Manual: `bun src/index.ts monitor`, press `W` on each filtered tab, confirm
  numbers change and Overview/Recent/Today do not.

## Estimated effort

Half a day to a day. The data path is a straight thread-through of an existing
`after` option; most of the work is the UI selector, per-window cache, and
test fixtures.
