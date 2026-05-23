/**
 * Standalone NWC test — create and pay a Lightning invoice.
 * Usage: bun test_nwc.ts [nostr+walletconnect://...]
 * Needs NWC_CONNECTION_STRING in .env or as CLI arg.
 */

import { createNwcClient, parseConnectionString } from "./src/daemon/wallet/nwc-client";

let cs = process.argv[2] || process.env.NWC_CONNECTION_STRING;
if (!cs) {
  try {
    for (const l of (await Bun.file(".env").text()).split("\n")) {
      const [k, ...v] = l.trim().split("=");
      if (k === "NWC_CONNECTION_STRING") { cs = v.join("="); break; }
    }
  } catch {}
}
if (!cs) {
  console.error("❌ Set NWC_CONNECTION_STRING in .env or pass as CLI arg");
  process.exit(1);
}

const client = createNwcClient({ connectionString: cs, replyTimeoutMs: 30000 });

try {
  console.log("🔌 Connecting...");
  await client.connect();
  console.log("✅ Connected\n");

  console.log("📄 make_invoice (1 sat)");
  const inv = await client.makeInvoice({ amount: 1, description: "NWC test" });
  console.log(`   hash   : ${inv.payment_hash}`);
  console.log(`   invoice: ${inv.invoice.slice(0, 60)}...`);

  console.log("\n💸 pay_invoice");
  const pay = await client.payInvoice(inv.invoice, 1);
  console.log(`✅ Paid — preimage: ${pay.preimage.slice(0, 16)}...`);

  console.log("\n✅ Done");
} catch (err) {
  console.error(`\n❌ ${(err as Error).message}`);
  process.exit(1);
} finally {
  client.disconnect();
}
