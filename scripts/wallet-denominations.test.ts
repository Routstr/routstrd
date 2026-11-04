import { expect, it } from "bun:test";
import { join } from "node:path";

it("uses denomination glyphs consistently for repeated proofs", () => {
  const result = Bun.spawnSync([
    process.execPath, join(import.meta.dir, "wallet-denominations.ts"),
    "--denoms", "1024x2,512", "--target", "1000",
  ]);
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  expect(output).toContain(`  ${"█".repeat(48)}${"▓".repeat(12)}\n`);
  expect(output).toContain("legend: █ 1,024  ▓ 512");
  expect(output).toContain("target 1,000 → token 1,024");
});
