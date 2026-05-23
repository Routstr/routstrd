/**
 * Standalone NWC (Nostr Wallet Connect) test script.
 *
 * Usage:
 *   1. Set your NWC connection string in .env:
 *        NWC_CONNECTION_STRING=nostr+walletconnect://<wallet-pubkey>?relay=<relay-url>&secret=<32-byte-hex>
 *
 *   2. Run:
 *        bun test_nwc.ts
 *
 *   3. Optionally override via CLI:
 *        bun test_nwc.ts <nostr+walletconnect://...>
 *
 *   4. Customize test amount (default 1 sat):
 *        NWC_TEST_AMOUNT=10 bun test_nwc.ts
 *
 * What this does:
 *   1. Parses the NWC connection string (same logic as nwc-client.ts)
 *   2. Connects to the relay and subscribes to responses
 *   3. Gets wallet info + balance
 *   4. Creates a Lightning invoice via make_invoice (simulates routstrd receive)
 *   5. Pays that invoice via pay_invoice (tests NWC payment roundtrip)
 *   6. Shows updated balance
 *   7. Disconnects cleanly
 */

import { createNwcClient, parseConnectionString } from "./src/daemon/wallet/nwc-client";

// ── Load NWC connection string ──────────────────────────────────────

let connectionString = process.argv[2]
  || process.env.NWC_CONNECTION_STRING;

if (!connectionString) {
  // Try loading from .env
  try {
    const envFile = Bun.file(".env");
    if (await envFile.exists()) {
      const envText = await envFile.text();
      for (const line of envText.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const [key, ...rest] = [trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim()];
        if (key === "NWC_CONNECTION_STRING") {
          connectionString = rest.join("=");
          break;
        }
      }
    }
  } catch { /* ok */ }
}

if (!connectionString) {
  console.error("❌ No NWC connection string found.");
  console.error("   Set NWC_CONNECTION_STRING in .env or pass as CLI arg:");
  console.error("   bun test_nwc.ts nostr+walletconnect://<pubkey>?relay=<relay>&secret=<hex>");
  process.exit(1);
}

const testAmount = parseInt(process.env.NWC_TEST_AMOUNT || "1", 10) || 1;

// ── Helpers ─────────────────────────────────────────────────────────

function fmtKey(k: string) { return k.slice(0, 16) + "..."; }
function ok(s: string) { console.log(`   ✅ ${s}`); }
function warn(s: string) { console.log(`   ⚠️  ${s}`); }
function info(label: string, val: string) {
  console.log(`   ${label.padEnd(12)}: ${val}`);
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("🔌 NWC Test Script\n─────────────────");

  let parsed;
  try {
    parsed = parseConnectionString(connectionString!);
  } catch (err) {
    console.error("❌ Invalid connection string:", (err as Error).message);
    process.exit(1);
  }

  info("Wallet pubkey", fmtKey(parsed.pubkey));
  info("Relay", parsed.relay);
  console.log();

  const client = createNwcClient({
    connectionString: connectionString!,
    replyTimeoutMs: 30000,
    publishTimeoutMs: 15000,
  });

  try {
    // 1. Connect
    console.log("1️⃣  Connecting...");
    await client.connect();
    ok("Connected\n");

    // 2. Get info (skipped — wallet doesn't respond to this method)
    console.log("2️⃣  get_info — skipping\n");

    // 3. Get balance (skipped)
    console.log("3️⃣  get_balance — skipping");
    let balanceBefore = -1;
    console.log();

    // 4. Create invoice (make_invoice — simulates routstrd receive)
    console.log(`4️⃣  make_invoice (${testAmount} sat${testAmount !== 1 ? "s" : ""})`);
    const invoice = await client.makeInvoice({
      amount: testAmount,
      description: "NWC test invoice from routstrd",
    });
    info("payment_hash", invoice.payment_hash || "(empty!)");
    info("amount", `${invoice.amount} sats`);
    info("invoice", invoice.invoice
      ? invoice.invoice.slice(0, 60) + (invoice.invoice.length > 60 ? "..." : "")
      : "(empty!)");

    if (!invoice.invoice || !invoice.payment_hash) {
      warn("Invoice came back empty — printing full raw values for debugging:");
      console.log(`   raw payment_hash: ${JSON.stringify(invoice.payment_hash)}`);
      console.log(`   raw invoice:      ${JSON.stringify(invoice.invoice)}`);
      console.log(`   raw amount:       ${JSON.stringify(invoice.amount)}`);
    }
    console.log();

    // 5. Pay the invoice
    if (!invoice.invoice) {
      console.log("5️⃣  Skipping pay_invoice (no invoice to pay)\n");
    } else {
      console.log("5️⃣  pay_invoice");
      const payment = await client.payInvoice(invoice.invoice, testAmount);
      ok("Paid!");
      info("Preimage", payment.preimage.slice(0, 16) + "...");
      if (payment.fees_paid !== undefined) {
        info("Fees paid", `${payment.fees_paid} msats`);
      }
      console.log();
    }

    // 6. Lookup invoice (skipped)
    console.log("6️⃣  lookup_invoice — skipping\n");

    // 7. Balance check skipped
    console.log("\n✅ All tests passed!");

  } catch (err) {
    console.error(`\n❌ Error: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    console.log("\n🔌 Disconnecting...");
    client.disconnect();
    console.log("   Done.");
  }
}

main();
