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

const combinedContent = leftLines.map((l, i) => l + (rightLines[i] || " ".repeat(halfWidth2))).join("\n");
console.log(combinedContent);
