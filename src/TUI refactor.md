# TUI refactor plan

## Goals
- Move the usage TUI implementation out of `src/cli/usage-tui.ts` into a dedicated `src/tui/` folder.
- Reduce the size and responsibility of the current monolithic file.
- Keep the existing CLI entrypoint stable so current usage does not break.
- Preserve behavior while making future TUI work easier.

## Current state
`src/cli/usage-tui.ts` currently mixes several concerns in one file:
- TUI-specific types and constants
- ANSI/terminal helpers
- scroll/search/vim navigation state
- data fetching from the daemon
- usage aggregation/stat helpers
- rendering for all tabs
- app lifecycle and keyboard event handling

This makes the file hard to extend safely.

## Refactor strategy
Do this incrementally and keep a thin compatibility wrapper in `src/cli/usage-tui.ts`.

### Target structure
- `src/tui/usage/index.ts`
  - public entrypoint: `runUsageTui()`
- `src/tui/usage/types.ts`
  - `UsageStats`, tab ids, tab metadata, derived stat types
- `src/tui/usage/constants.ts`
  - tabs, colors, model/client color maps
- `src/tui/usage/terminal.ts`
  - ANSI helpers, width/height helpers, `stripAnsi`
- `src/tui/usage/state.ts`
  - vim/search/scroll state and state mutation helpers
- `src/tui/usage/data.ts`
  - `fetchUsage()` and usage aggregation helpers
- `src/tui/usage/render.ts`
  - shared render helpers and tab renderers
- `src/tui/usage/app.ts`
  - main loop, render orchestration, input handling, cleanup
- `src/cli/usage-tui.ts`
  - compatibility wrapper that re-exports or calls `runUsageTui()` from `src/tui/usage`

## Design choices
### 1. Keep CLI path compatibility
Do not delete the CLI file outright. Turn it into a tiny wrapper:
- minimal import from `../tui/usage/index.ts`
- export `runUsageTui()`

This avoids breaking any existing imports or scripts.

### 2. Separate pure logic from side effects
Keep these pure where possible:
- aggregation helpers
- formatting helpers
- render helpers that return strings
- scroll clamping logic

Keep side effects isolated in the app layer:
- reading terminal size
- writing to stdout
- raw mode setup
- signal handling
- interval scheduling

### 3. Avoid over-engineering
This should be a pragmatic refactor, not a framework:
- no unnecessary classes
- keep function-based design
- only extract modules around clear responsibility boundaries

### 4. Preserve behavior first
No UX changes unless needed to support the extraction.
That means:
- same tabs
- same keybindings
- same output format
- same fetch cadence
- same search/scroll behavior

## Implementation steps
1. Create `src/tui/usage/`.
2. Extract types/constants first.
3. Extract terminal helpers.
4. Extract data fetching + aggregation helpers.
5. Extract state/search/scroll logic.
6. Extract rendering helpers + tab renderers.
7. Build `app.ts` using the extracted modules.
8. Replace `src/cli/usage-tui.ts` with a thin wrapper.
9. Run a TypeScript/bun check and fix imports.
10. Smoke-test keyboard handling and rendering behavior.

## Risks
- circular imports between render/state/constants
- broken relative import paths during extraction
- subtle behavior regressions in scroll/search state
- terminal escape handling differences if helpers are split carelessly

## Validation checklist
- `src/cli/usage-tui.ts` still exposes `runUsageTui()`
- TUI starts from the same CLI path
- scroll still works for long content
- vim keys still work
- arrow keys still work
- tab switching still resets scroll
- search mode still works
- cleanup still restores cursor and alternate screen

## Non-goals
- redesigning the UI
- changing tab contents
- introducing tests unless needed for safety
- adding new features unrelated to the refactor
