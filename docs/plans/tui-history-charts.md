# TUI "History" tab with adaptive bar charts

> **Status:** implemented. Branch `feat/tui-history-charts`
> (worktree `.worktrees/tui-history-charts`, based on `main` @ `5069b2d`).

## Goal

Replace the old **Today** tab (a totals box + a text "Recent Days" list + a
horizontal hourly bar list) with a **History** tab that draws usage over time
as bar charts, with the bucketing driven by the existing `[W]` time-window
selector.

| `[W]` window | Bucket | Bars |
| ------------ | ------ | ---- |
| `24h`        | hour   | 24   |
| `7d`         | day    | 7    |
| `30d`        | day    | 30   |
| `All`        | month  | one per calendar month since first usage |

Y-axis is total spend; a token sparkline shares the x-axis (scaled
independently to peak tokens, with both totals in the legend). This also makes
the tab window-aware: the selector was previously hidden on it.

## Backend — `src/daemon/http/usage-summary.ts`

- New `TimelineBucket` (`hour` | `day` | `month`), `TimelinePoint` and
  `Timeline` types; `WindowedStats` gains a required `timeline: Timeline`.
- `buildTimeline(driver, baseFilter, window, now, tzOffsetMinutes)`:
  - `today` (24h) → `aggregate({ groupBy: "hour" })` over the last 24
    local-aligned hours. The SDK's `hour` key is `HH` with no date, so the
    window is aligned to whole hours (each hour-of-day appears at most once).
  - `7d` / `30d` → `aggregate({ groupBy: "day" })` over the last N days.
  - `all` → `aggregate({ groupBy: "day" })` with no `after`, folded into
    `YYYY-MM` months. The SDK has no `month` grouping, hence the fold.
  - Every series is zero-filled so the x-axis is evenly spaced.
- `buildTimeline` is called once per summary build (after `buildAggregates`)
  and attached to both the all-time and windowed blocks. The zero-data
  short-circuit returns an empty timeline.

## TUI

- `types.ts` — `TabId` `"today"` → `"history"`; re-export the timeline types.
- `constants.ts` — tab renamed to `History`; `tabSupportsWindow` now excludes
  only Overview and Recent.
- `render.ts` — `renderToday` replaced by `renderHistory` +
  `renderTimelineChart` (vertical bars, y-axis gutter, x labels, token
  sparkline, legend). Long series are merged to fit narrow terminals.
- `data.ts` — the old-daemon fallback `windowFromAllTime` supplies an empty
  timeline.

## Tests

- `src/daemon/http/usage-summary.test.ts` — hourly / 7-day / 30-day /
  month-folded timelines, including zero-fill and window totals.
- `src/tui/usage/render.test.ts` — axis, labels, sparkline, legend, empty
  state, and full-width alignment of every rendered line.

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
