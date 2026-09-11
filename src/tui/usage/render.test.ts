import { describe, it, expect } from "bun:test";
import { renderBox } from "./render";
import { stripAnsi } from "./terminal";

/** Visible column count of a rendered line, ignoring ANSI colour codes. */
function visibleWidths(box: string): number[] {
  return box.split("\n").map((line) => stripAnsi(line).length);
}

describe("renderBox", () => {
  it("renders every line at the requested width when given a title", () => {
    const box = renderBox(["Hello World", "Line 2"], 40, "Title");

    expect(box.split("\n")).toHaveLength(4); // top, 2 content rows, bottom
    for (const width of visibleWidths(box)) {
      expect(width).toBe(40);
    }
  });

  it("renders every line at the requested width without a title", () => {
    const box = renderBox(["Hello World", "Line 2"], 40);

    for (const width of visibleWidths(box)) {
      expect(width).toBe(40);
    }
  });

  it("puts the title in the top border", () => {
    const [topBorder] = renderBox(["body"], 40, "Stats of Sats").split("\n");

    expect(topBorder).toContain("Stats of Sats");
  });

  it("pads content rows so ANSI-coloured lines still align", () => {
    const colored = "\x1b[32mgreen\x1b[0m";
    const box = renderBox([colored, "plain"], 30);

    for (const width of visibleWidths(box)) {
      expect(width).toBe(30);
    }
  });

  it("composes two half-width boxes into rows of the full width", () => {
    const width = 80;
    const halfWidth1 = Math.floor(width / 2);
    const halfWidth2 = width - halfWidth1;

    const left = renderBox(
      ["Total Spent: 12.78k sats", "Total Requests: 1.0k"],
      halfWidth1,
      "Stats of Sats",
    ).split("\n");
    const right = renderBox(
      ["Total Tokens: 25.8M", "Avg Tokens/Req: 25.8K"],
      halfWidth2,
      "Token Stats",
    ).split("\n");

    expect(left).toHaveLength(right.length);
    for (let i = 0; i < left.length; i++) {
      expect(stripAnsi(left[i]! + right[i]!).length).toBe(width);
    }
  });

  it("pads the shorter side when the two boxes have unequal heights", () => {
    const width = 80;
    const halfWidth1 = Math.floor(width / 2);
    const halfWidth2 = width - halfWidth1;

    const left = renderBox(["a", "b", "c"], halfWidth1, "Left").split("\n");
    const right = renderBox(["x"], halfWidth2, "Right").split("\n");

    const rows = Math.max(left.length, right.length);
    for (let i = 0; i < rows; i++) {
      const l = left[i] ?? " ".repeat(halfWidth1);
      const r = right[i] ?? " ".repeat(halfWidth2);
      expect(stripAnsi(l + r).length).toBe(width);
    }
  });
});
