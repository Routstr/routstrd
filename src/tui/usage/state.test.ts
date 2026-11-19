import { beforeEach, describe, expect, it } from "bun:test";
import {
  consumeMotionPrefix,
  exitSearchMode,
  isSearching,
  setMode,
  startSearch,
  vimState,
} from "./state.ts";
import { MOTION_PREFIX_TIMEOUT_MS } from "./types.ts";

/**
 * The TUI key state used to record its mode twice: a `mode` string and an
 * `isSearching` boolean that had to be flipped in step with it. A missed
 * assignment was invisible to the type checker and only showed up as a search
 * prompt rendering over a normal-mode keymap. These tests pin the invariant
 * that mode is derived from one field, plus the `gg` prefix behaviour that
 * replaced a "lastKey + lastKeyTime" pair.
 */
describe("TUI input mode", () => {
  beforeEach(() => {
    setMode("normal");
    vimState.searchQuery = "";
    vimState.searchResults = [];
    vimState.currentSearchIdx = 0;
    vimState.searchReverse = false;
  });

  it("derives search state from mode alone", () => {
    expect(isSearching()).toBe(false);
    expect(vimState.mode).toBe("normal");

    startSearch(false);
    expect(isSearching()).toBe(true);
    expect(vimState.mode).toBe("search");

    exitSearchMode();
    expect(isSearching()).toBe(false);
    expect(vimState.mode).toBe("normal");
  });

  it("keeps reverse-search direction across the prompt closing", () => {
    // `searchReverse` selects `/` vs `?` and also the direction `n`/`N`
    // continue in after Enter, so dismissing the prompt must not reset it.
    startSearch(true);
    expect(vimState.searchReverse).toBe(true);
    exitSearchMode();
    expect(vimState.searchReverse).toBe(true);
  });

  it("clears a half-typed motion when the mode changes", () => {
    expect(consumeMotionPrefix("g", 1_000)).toBe(false);
    expect(vimState.pendingMotion).not.toBeNull();

    // Switching to search must not leave a `g` waiting to complete an `gg`
    // against a key pressed after the prompt is dismissed.
    startSearch(false);
    expect(vimState.pendingMotion).toBeNull();
  });
});

describe("gg motion prefix", () => {
  beforeEach(() => {
    setMode("normal");
  });

  it("reports the second g inside the timeout as a completed motion", () => {
    expect(consumeMotionPrefix("g", 1_000)).toBe(false);
    expect(consumeMotionPrefix("g", 1_000 + MOTION_PREFIX_TIMEOUT_MS - 1)).toBe(true);
    // The prefix is consumed, so a third `g` starts a new one.
    expect(consumeMotionPrefix("g", 1_000 + MOTION_PREFIX_TIMEOUT_MS)).toBe(false);
  });

  it("expires a prefix that outlived the timeout", () => {
    expect(consumeMotionPrefix("g", 1_000)).toBe(false);
    expect(consumeMotionPrefix("g", 1_000 + MOTION_PREFIX_TIMEOUT_MS)).toBe(false);
  });

  it("does not complete across a different prefix key", () => {
    expect(consumeMotionPrefix("g", 1_000)).toBe(false);
    expect(consumeMotionPrefix("G", 1_010)).toBe(false);
    expect(vimState.pendingMotion).toEqual({ key: "G", at: 1_010 });
  });
});
