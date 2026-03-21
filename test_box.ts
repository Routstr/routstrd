import { renderBox } from "./src/tui/usage/render.ts";
import { stripAnsi } from "./src/tui/usage/terminal.ts";

const w = 40;
const testBox = renderBox(["Hello World", "Line 2"], w, "Title");
console.log(testBox);
const lines = testBox.split("\n");
lines.forEach((l, i) => console.log(`Line ${i} length: ${stripAnsi(l).length}`));

console.log("---");

const testBoxNoTitle = renderBox(["Hello World", "Line 2"], w);
console.log(testBoxNoTitle);
const lines2 = testBoxNoTitle.split("\n");
lines2.forEach((l, i) => console.log(`Line ${i} length: ${stripAnsi(l).length}`));
