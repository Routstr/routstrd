# TUI "History" tab with adaptive bar charts

> **Status:** implemented. Branch `feat/tui-history-charts`
> (worktree `.worktrees/tui-history-charts`, based on `main` @ `5069b2d`).
> The dual-axis grouped-bar revision lives on `main` (uncommitted at the time
> of writing).

## Goal

Replace the old **Today** tab (a totals box + a text "Recent Days" list + a
horizontal hourly bar list) with a **History** tab that draws usage over time
as bar charts, with the bucketing driven by the existing `[W]` time-window
selector.

| `[W]` window | Bucket | Bars |
| ------------ | ------ | ---- |
| `24h`        | hour   | 24   |
| `7d`         | hour   | 7 × 24, merged to fit the width |
| `30d`        | day    | 30   |
| `All`        | week (ISO, Monday) | one per week since first usage |

Each bucket draws two grouped bars — orange **spend** (left axis, sats) and
red **tokens** (right axis, tokens) — flush inside the pair with a gap
between buckets. The summary is a single compact line and the chart grows to
fill the terminal height.

## Backend — `src/daemon/http/usage-summary.ts`

- New `TimelineBucket` (`hour` | `day` | `week`), `TimelinePoint` and
  `Timeline` types; `WindowedStats` gains a required `timeline: Timeline`.
- `buildTimeline(driver, baseFilter, window, now, tzOffsetMinutes)`:
  - `today` (24h) → `aggregate({ groupBy: "hour" })` over the last 24
    local-aligned hours. The SDK's `hour` key is `HH` with no date, so the
    window is aligned to whole hours (each hour-of-day appears at most once).
  - `7d` → 7 × 24 hourly buckets. Because the `hour` key has no date, each
    local day is aggregated over its own `[start, end)` range and the buckets
    concatenated.
  - `30d` → `aggregate({ groupBy: "day" })` over the last 30 days.
  - `all` → `aggregate({ groupBy: "day" })` with no `after`, folded into ISO
    weeks (Monday start). The SDK has no `week` grouping, hence the fold.
  - Every series is zero-filled so the x-axis is evenly spaced.
- `buildTimeline` is called once per summary build (after `buildAggregates`)
  and attached to both the all-time and windowed blocks. The zero-data
  short-circuit returns an empty timeline.

## TUI

- `types.ts` — `TabId` `"today"` → `"history"`; re-export the timeline types.
- `constants.ts` — tab renamed to `History`; `tabSupportsWindow` now excludes
  only Overview and Recent.
- `render.ts` — `renderToday` replaced by `renderHistory` +
  `renderTimelineChart` (dual-axis grouped bars, y-axis gutters, x labels,
  legend). Buckets are merged when they no longer fit; the chart height is
  derived from the viewport so the tab fills the terminal.
- `app.ts` — passes the content height into the tab renderer and pads the
  content so the footer stays pinned to the bottom.
- `data.ts` — the old-daemon fallback `windowFromAllTime` supplies an empty
  timeline.

## Tests

- `src/daemon/http/usage-summary.test.ts` — hourly / 7-day-hourly / 30-day /
  week-folded timelines, including zero-fill and window totals.
- `src/tui/usage/render.test.ts` — dual-axis grouped bars, labels, legend,
  empty state, height-filling, and full-width alignment of every line.

## Notes / limits

- Daemons too old to return `timeline` still render: the History tab falls
  back to an empty chart rather than erroring.
- The 24h window is hour-aligned rather than a rolling `now - 24h`, so each
  hour-of-day appears once and the `HH` keys stay unambiguous.
- The windowed aggregates use the same bucket-aligned boundary as the chart
  (`windowRangeStartUtc`), so a tab's totals always equal the sum of its bars:
  24 whole hours for `24h`, whole local days for `7d`/`30d`. Before this, the
  `24h` totals were calendar-day (since local midnight) while the chart drew
  a rolling 24h, and `7d`/`30d` totals were exact rolling windows while the
  chart snapped to whole days.
