import { renderBox } from "./src/tui/usage/render.ts";

const width = 80;
const halfWidth1 = Math.floor(width / 2);
const halfWidth2 = width - halfWidth1;

const leftBox = ["Total Spent: 12.78k sats", "Total Requests: 1.0k"];
const rightBox = ["Total Tokens: 25.8M", "Avg Tokens/Req: 25.8K"];

const leftBoxStr = renderBox(leftBox, halfWidth1, "Stats of Sats");
const rightBoxStr = renderBox(rightBox, halfWidth2, "Token Stats");

const leftLines = leftBoxStr.split("\n");
const rightLines = rightBoxStr.split("\n");

const maxLines = Math.max(leftLines.length, rightLines.length);
const combinedLines: string[] = [];
for (let i = 0; i < maxLines; i++) {
  const l = leftLines[i] || " ".repeat(Math.floor(width / 2));
  const r = rightLines[i] || " ".repeat(Math.ceil(width / 2));
  combinedLines.push(l + r);
}
console.log(combinedLines.join("\n"));
