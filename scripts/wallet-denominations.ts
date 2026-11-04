#!/usr/bin/env bun
/**
 * Visualise the Cashu proof denominations in a routstrd wallet.
 *
 * Offline sends (`routstrd send <amount> --offline`) never swap, so the only
 * amounts you can send are subset sums of the proofs you already hold. This
 * script reads the wallet database read-only and shows:
 *
 *   1. the denomination histogram for each mint,
 *   2. the exact amounts that can be sent with zero overpayment,
 *   3. the token the offline selector would pick for any requested amount.
 *
 * Usage:
 *   bun scripts/wallet-denominations.ts
 *   bun scripts/wallet-denominations.ts --mint https://mint.cubabitcoin.org
 *   bun scripts/wallet-denominations.ts --db ~/.routstrd/wallet/coco.db
 *   bun scripts/wallet-denominations.ts --denoms 1024,512,64 --target 1000
 *   bun scripts/wallet-denominations.ts --denoms 1024,512,64 --targets 10,100,500,1000,1600
 *
 * Flags:
 *   --db <path>      coco.db to read (default: $ROUTSTRD_DIR/wallet/coco.db)
 *   --mint <url>     only show this mint
 *   --state <s>      'available' (default: ready + not reserved) or 'all'
 *   --denoms <list>  use a hypothetical proof set instead of a database
 *                    (exact values, e.g. 1024,512,64 or 1024x2,512)
 *   --target <n>     show the offline selection for one amount
 *   --targets <list> show the offline selection for several amounts
 *   --wide           draw a wider composition strip (default 60 chars)
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CoreProof } from "@cashu/coco-core";
// The real selector, so this preview cannot drift from `send --offline`.
import { selectClosestProofs as productionSelectClosestProofs } from "../src/daemon/wallet/offline-send.ts";

interface Options {
  db: string;
  mint?: string;
  state: "available" | "all";
  denoms?: number[];
  targets: number[];
  wide: boolean;
}

interface Proof {
  mintUrl: string;
  amount: number;
  secret: string;
}

function defaultDbPath(): string {
  const root = process.env.ROUTSTRD_DIR || join(homedir(), ".routstrd");
  return join(root, "wallet", "coco.db");
}

function parseList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [amountRaw, countRaw] = part.split(/[x*]/);
      const amount = Number(amountRaw);
      const count = countRaw === undefined ? 1 : Number(countRaw);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error(`Invalid denomination: ${part}`);
      }
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`Invalid denomination count: ${part}`);
      }
      return Array.from({ length: count }, () => amount);
    })
    .flat();
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    db: defaultDbPath(),
    state: "available",
    targets: [],
    wide: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--db":
        options.db = argv[++i]!;
        break;
      case "--mint":
        options.mint = argv[++i]!;
        break;
      case "--state": {
        const state = argv[++i];
        if (state !== "available" && state !== "all") {
          throw new Error(`--state must be 'available' or 'all', got '${state}'`);
        }
        options.state = state;
        break;
      }
      case "--denoms":
        options.denoms = parseList(argv[++i]).sort((a, b) => b - a);
        break;
      case "--target":
        options.targets.push(...parseList(argv[++i]));
        break;
      case "--targets":
        options.targets.push(...parseList(argv[++i]));
        break;
      case "--wide":
        options.wide = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: bun scripts/wallet-denominations.ts [--db <path>] [--mint <url>] " +
            "[--state available|all] [--denoms 1024,512,64] [--target N] [--targets N,N,...]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

interface WalletSnapshot {
  byMint: Map<string, Proof[]>;
  /** Per-mint amount/count that is inflight or reserved and cannot be spent offline. */
  excluded: Map<string, { count: number; amount: number }>;
}

function readProofs(options: Options): WalletSnapshot {
  const byMint = new Map<string, Proof[]>();
  const excluded = new Map<string, { count: number; amount: number }>();
  if (options.denoms) {
    const mintUrl = options.mint ?? "hypothetical";
    byMint.set(
      mintUrl,
      options.denoms.map((amount, index) => ({
        mintUrl,
        amount,
        secret: `synthetic-${index}`,
      })),
    );
    return { byMint, excluded };
  }

  if (!existsSync(options.db)) {
    throw new Error(
      `Wallet database not found: ${options.db}\n` +
        "Pass --db <path>, or --denoms 1024,512,64 for a hypothetical wallet.",
    );
  }

  const database = new Database(options.db, { readonly: true });
  try {
    const stateClause =
      options.state === "available"
        ? "state = 'ready' AND usedByOperationId IS NULL"
        : "state != 'spent'";
    const mintClause = options.mint ? " AND mintUrl = ?" : "";
    const rows = database
      .query(
        `SELECT mintUrl, amount, secret FROM coco_cashu_proofs ` +
          `WHERE ${stateClause}${mintClause} ORDER BY mintUrl, amount DESC`,
      )
      .all(...(options.mint ? [options.mint] : [])) as Proof[];
    for (const row of rows) {
      const list = byMint.get(row.mintUrl) ?? [];
      list.push(row);
      byMint.set(row.mintUrl, list);
    }

    if (options.state === "available") {
      const excludedRows = database
        .query(
          `SELECT mintUrl, COUNT(*) count, COALESCE(SUM(amount), 0) amount ` +
            `FROM coco_cashu_proofs WHERE state != 'spent'` +
            `${options.mint ? " AND mintUrl = ?" : ""} GROUP BY mintUrl`,
        )
        .all(...(options.mint ? [options.mint] : [])) as {
        mintUrl: string;
        count: number;
        amount: number;
      }[];
      for (const row of excludedRows) {
        const availableCount = byMint.get(row.mintUrl)?.length ?? 0;
        const availableAmount =
          byMint.get(row.mintUrl)?.reduce((sum, proof) => sum + proof.amount, 0) ?? 0;
        excluded.set(row.mintUrl, {
          count: row.count - availableCount,
          amount: row.amount - availableAmount,
        });
      }
    }
  } finally {
    database.close();
  }
  return { byMint, excluded };
}

function histogram(proofs: Proof[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const proof of proofs) {
    counts.set(proof.amount, (counts.get(proof.amount) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => b[0] - a[0]));
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0 && Number.isSafeInteger(value);
}

/** Distinct subset sums, capped so a huge wallet cannot freeze the script. */
function subsetSums(proofs: Proof[]): number[] | null {
  const total = proofs.reduce((sum, proof) => sum + proof.amount, 0);
  if (total > 2_000_000 || proofs.length > 25) return null;
  const reachable = new Uint8Array(total + 1);
  reachable[0] = 1;
  let max = 0;
  for (const proof of proofs) {
    for (let sum = max; sum >= 0; sum--) {
      if (reachable[sum]) reachable[sum + proof.amount] = 1;
    }
    max += proof.amount;
  }
  const sums: number[] = [];
  for (let sum = 0; sum <= total; sum++) if (reachable[sum]) sums.push(sum);
  return sums;
}

function toCoreProof(proof: Proof): CoreProof {
  return {
    mintUrl: proof.mintUrl,
    id: "preview",
    amount: proof.amount,
    secret: proof.secret,
    C: `C-${proof.secret}`,
    state: "ready",
  };
}

function selectClosestProofs(proofs: readonly Proof[], amount: number): Proof[] | null {
  const selected = productionSelectClosestProofs(proofs.map(toCoreProof), amount);
  if (!selected) return null;
  const bySecret = new Map(proofs.map((proof) => [proof.secret, proof]));
  return selected.map((proof) => bySecret.get(proof.secret)!);
}

function bar(value: number, max: number, width: number): string {
  if (max <= 0) return "";
  const length = Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width));
  return "█".repeat(length);
}

function money(value: number): string {
  return value.toLocaleString("en-US");
}

function percent(value: number, total: number): string {
  if (total <= 0) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

const COMPOSITION_GLYPHS = ["█", "▓", "▒", "░", "▚", "▞", "▛", "▜"];

function strip(proofs: Proof[], width: number, glyphByAmount: Map<number, string>): string {
  const total = proofs.reduce((sum, proof) => sum + proof.amount, 0);
  if (total <= 0) return "";
  // Largest-remainder apportionment so the strip length is exactly `width`.
  const raw = proofs.map((proof) => (proof.amount / total) * width);
  const cells = raw.map(Math.floor);
  let remainder = width - cells.reduce((sum, cell) => sum + cell, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; remainder > 0; i++, remainder--) {
    cells[order[i % order.length]!.index]! += 1;
  }
  return proofs.map((proof, index) => glyphByAmount.get(proof.amount)!.repeat(cells[index]!)).join("");
}

function renderMint(
  mintUrl: string,
  proofs: Proof[],
  options: Options,
  excluded?: { count: number; amount: number },
): void {
  const counts = histogram(proofs);
  const glyphByAmount = new Map([...counts.keys()].map((amount, index) =>
    [amount, COMPOSITION_GLYPHS[index % COMPOSITION_GLYPHS.length]!] as const,
  ));
  const total = proofs.reduce((sum, proof) => sum + proof.amount, 0);
  const largest = proofs[0]?.amount ?? 0;
  const smallest = proofs.at(-1)?.amount ?? 0;
  const allBinary = proofs.every((proof) => isPowerOfTwo(proof.amount));
  const width = options.wide ? 100 : 60;

  console.log("");
  console.log(`Mint: ${mintUrl}`);
  console.log(`Balance: ${money(total)} sat across ${proofs.length} proof${proofs.length === 1 ? "" : "s"}`);
  if (excluded && excluded.count > 0) {
    console.log(
      `Not spendable offline: ${money(excluded.amount)} sat in ${excluded.count} ` +
        `inflight/reserved proof${excluded.count === 1 ? "" : "s"}`,
    );
  }
  console.log("");

  const maxSubtotal = Math.max(
    ...[...counts.entries()].map(([amount, count]) => amount * count),
  );
  console.log("  Denomination   Count   Subtotal   Share   Histogram");
  console.log("  ────────────   ─────   ────────   ─────   ─────────");
  for (const [amount, count] of counts) {
    const subtotal = amount * count;
    console.log(
      `  ${String(money(amount)).padStart(12)}   ${String(count).padStart(5)}   ` +
        `${String(money(subtotal)).padStart(8)}   ${percent(subtotal, total).padStart(5)}   ` +
        `${bar(subtotal, maxSubtotal, width - 24)}`,
    );
  }
  console.log("  ────────────   ─────   ────────   ─────");
  console.log(
    `  ${"total".padStart(12)}   ${String(proofs.length).padStart(5)}   ` +
      `${String(money(total)).padStart(8)}   100.0%`,
  );

  if (proofs.length > 0) {
    console.log("");
    console.log(`  Composition (largest → smallest, ${width} cells):`);
    console.log(`  ${strip(proofs, width, glyphByAmount)}`);
    console.log(
      `  legend: ${[...counts.keys()]
        .map((amount) => `${glyphByAmount.get(amount)} ${money(amount)}`)
        .join("  ")}`,
    );
  }

  console.log("");
  console.log(
    `  Largest proof: ${money(largest)} sat (${percent(largest, total)} of balance)   ` +
      `Smallest: ${money(smallest)} sat   Power-of-two set: ${allBinary ? "yes" : "no"}`,
  );

  // ---- offline send landscape -------------------------------------------
  console.log("");
  console.log("  Offline send (no swap)");
  console.log("  ──────────────────────");

  const sums = subsetSums(proofs);
  if (!sums) {
    console.log(
      "  Too many proofs to enumerate every subset sum; showing the requested amounts only.",
    );
  } else {
    const exact = sums.filter((sum) => sum > 0);
    const shown = exact.slice(0, 48);
    console.log(
      `  Exact sendable amounts (${exact.length} of ${money(total)} sats):` +
        (exact.length > 0 ? "" : " none"),
    );
    if (shown.length > 0) {
      console.log(`    ${shown.map(money).join(", ")}${exact.length > shown.length ? ", …" : ""}`);
    }

    // Buckets: every requested amount maps to the smallest subset sum >= it.
    const buckets: { from: number; to: number; token: number }[] = [];
    for (let i = 0; i < exact.length; i++) {
      const from = i === 0 ? 1 : exact[i - 1]! + 1;
      buckets.push({ from, to: exact[i]!, token: exact[i]! });
    }
    if (buckets.length <= 40) {
      console.log("");
      console.log("  Requested range → token actually sent");
      for (const bucket of buckets) {
        const overpay = bucket.token - bucket.from;
        const range =
          bucket.from === bucket.token ? money(bucket.token) : `${money(bucket.from)}–${money(bucket.to)}`;
        console.log(
          `    ${range.padStart(18)} → ${money(bucket.token).padStart(7)}` +
            `   ${overpay === 0 ? "exact" : `overpay up to +${money(overpay)}`}`,
        );
      }
    }
  }

  for (const target of options.targets) {
    console.log("");
    if (target <= 0 || !Number.isSafeInteger(target)) {
      console.log(`  target ${target}: invalid amount`);
      continue;
    }
    const selected = selectClosestProofs(proofs, target);
    if (!selected) {
      console.log(`  target ${money(target)}: impossible — balance is only ${money(total)} sat`);
      continue;
    }
    const token = selected.reduce((sum, proof) => sum + proof.amount, 0);
    const overpay = token - target;
    console.log(
      `  target ${money(target)} → token ${money(token)} ` +
        `(${overpay === 0 ? "exact" : `overpay +${money(overpay)} (${percent(overpay, target)})`})`,
    );
    console.log(
      `    proofs: ${selected.map((proof) => proof.amount).sort((a, b) => b - a).join(" + ")}` +
        ` = ${money(token)}`,
    );
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const { byMint, excluded } = readProofs(options);

  console.log("Wallet denominations");
  console.log("════════════════════");
  console.log(
    options.denoms
      ? "Source: hypothetical proof set (--denoms)"
      : `Source: ${options.db} (${options.state === "available" ? "ready, unreserved" : "all non-spent"})`,
  );

  if (byMint.size === 0) {
    console.log("");
    console.log("No matching proofs found.");
    return;
  }

  for (const [mintUrl, proofs] of byMint) {
    renderMint(mintUrl, proofs, options, excluded.get(mintUrl));
  }
  console.log("");
}

main();
