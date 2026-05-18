# NWC Integration for routstrd

## Table of Contents

1. [What is NWC](#what-is-nwc)
2. [Current State: routstr-chat's NWC Setup](#current-state-routstr-chats-nwc-setup)
3. [Current State: routstrd's Wallet Architecture](#current-state-routstrds-wallet-architecture)
4. [Why NWC in routstrd](#why-nwc-in-routstrd)
5. [Architecture Proposal](#architecture-proposal)
6. [Configuration](#configuration)
7. [NWC Wallet Adapter](#nwc-wallet-adapter)
8. [Auto-Refill / Auto-Topup](#auto-refill--auto-topup)
9. [Tradeoffs: NWC vs cocod (Cashu-native)](#tradeoffs-nwc-vs-cocod-cashu-native)
10. [Implementation Plan](#implementation-plan)

---

## What is NWC

Nostr Wallet Connect (NWC) is an open protocol that allows apps to connect to Lightning wallets via Nostr relays. It's defined by [NIP-47](https://nwc.dev) and uses a **connection string** format:

```
nostr+walletconnect://<pubkey>?relay=<relay_url>&secret=<32_byte_hex>
```

The protocol works as follows:

1. A **wallet service** (e.g., Alby Hub) generates a connection secret with a Nostr keypair and relay URL
2. The user copies/pastes this into the **client app**
3. The app encrypts NIP-47 request events with the shared secret and publishes them to the relay
4. The wallet service decrypts, authorizes, executes (e.g., pays an invoice), and responds with an encrypted event

**Capabilities** (requested at connection time):

| Method            | What it does                          |
|-------------------|---------------------------------------|
| `pay_invoice`     | Pay a BOLT-11 Lightning invoice       |
| `get_balance`     | Read wallet balance                   |
| `make_invoice`    | Create a Lightning invoice            |
| `lookup_invoice`  | Look up invoice by payment hash        |
| `get_info`        | Wallet metadata (alias, network, etc) |
| `list_transactions` | List transaction history            |
| `sign_message`    | Sign a message with node key          |

Key libraries: `@getalby/bitcoin-connect-react` (React UI), `nostr-core` (low-level TypeScript), and `@nostr-dev-kit/ndk` (Nostr Development Kit).

---

## Current State: routstr-chat's NWC Setup

routstr-chat (the Next.js frontend) already has a complete NWC integration via **`@getalby/bitcoin-connect-react` v3.10.0**.

### Connection Layer

```
┌─────────────────────────────────────────────────┐
│            @getalby/bitcoin-connect-react         │
│                                                   │
│  init() ─────────────────────── BitcoinConnectClient.tsx │
│    appName: "Routstr Chat"                        │
│    filters: ["nwc"]        ← NWC only, no WebLN  │
│    persistConnection: true  ← survive page reload │
│    showBalance: true                              │
│    providerConfig.nwc.authorizationUrlOptions     │
│      .requestMethods: [                           │
│        "pay_invoice",                             │
│        "get_balance",                             │
│        "make_invoice",                            │
│        "lookup_invoice"                           │
│      ]                                            │
└──────┬──────────────────────────────────────────┘
       │  import("@getalby/bitcoin-connect-react")
       │
  ┌────▼──────────────────────────────────┐
  │     useBitcoinConnectStatus() hook     │   hooks/useBitcoinConnect.tsx
  │                                        │
  │  status: connected|connecting|disconn  │
  │  balance: number|null (sats)           │
  │  providerName: string|null             │
  │  connect() / disconnect() / reset()    │
  └────┬──────────────────────────────────┘
       │
  ┌────▼──────────────────────────┐
  │     lib/nwcPayment.ts          │
  │                                │
  │  payWithNWC(amount, mintUrl)   │
  │  1. Create invoice on Cashu    │
  │     mint                       │
  │  2. Pay invoice via NWC        │
  │     sendPayment(invoice)       │
  │  3. Mint tokens from paid      │
  │     invoice                    │
  │  4. Poll up to 30s if needed   │
  └────┬──────────────────────────┘
       │
  ┌────▼──────────────────────────┐
  │    hooks/useAutoRefill.ts      │
  │                                │
  │  Monitors Cashu balance        │
  │  Triggers payWithNWC when:     │
  │   • balance < threshold (500)  │
  │   • cooldown passed (5 min)    │
  │   • wallet loaded              │
  └────────────────────────────────┘
```

### UI Components

| Component                     | Purpose                                          |
|-------------------------------|--------------------------------------------------|
| `NWCWalletManager.tsx`        | Settings page: connect/disconnect, wallet name, balance |
| `BitcoinConnectStatusRow.tsx` | Compact inline status (used in deposit modals)   |
| `TopUpPromptModal.tsx`        | Prompts user to connect NWC when balance is low  |

### Key Design Decisions

- **NWC-only filter** — no browser extension (WebLN) support; NWC is the sole connection path
- **Persistent connections** — `persistConnection: true` means the library stores the connection secret and reconnects on page load
- **4 NIP-47 methods** requested: `pay_invoice`, `get_balance`, `make_invoice`, `lookup_invoice`
- **Balance in sats** — the hook normalizes both `balance` (sats) and `balanceMsats` (millisats) responses
- **Auto-refill polling** at 5-second intervals with a 5-minute cooldown

---

## Current State: routstrd's Wallet Architecture

routstrd is a **Bun-based daemon/CLI** that routes LLM requests, manages providers, and handles payment via Cashu.

### Wallet Layer

```
┌───────────────────────────────────────┐
│           routstrd CLI / HTTP          │
│                                        │
│  routstrd wallet status                │
│  routstrd wallet balance               │
│  routstrd wallet receive cashu <token> │
│  routstrd wallet send cashu <amount>   │
│  routstrd wallet receive bolt11 <amt>  │
│  routstrd wallet send bolt11 <invoice> │
│                                        │
│  Daemon HTTP API:                      │
│  GET  /wallet/balances                 │
│  POST /wallet/send                     │
│  POST /wallet/receive                  │
└────────┬──────────────────────────────┘
         │
┌────────▼──────────────────────────────┐
│    daemon/wallet/index.ts              │
│    createWalletAdapter()               │
│                                        │
│  getBalances() → Record<mintUrl, sats>│
│  getMintUnits()                        │
│  getActiveMintUrl()                    │
│  sendToken(mintUrl, amount) → token    │
│  receiveToken(token) → { success, ... }│
└────────┬──────────────────────────────┘
         │
┌────────▼──────────────────────────────┐
│    daemon/wallet/cocod-client.ts       │
│    CocodClient (Unix socket HTTP)      │
│                                        │
│  ping(), getStatus(), unlock()         │
│  getBalances(), listMints()            │
│  receiveCashu(token), sendCashu(amt)   │
│  receiveBolt11(amt), sendBolt11(inv)   │
│  addMint(url), getMintInfo(url)        │
└────────┬──────────────────────────────┘
         │
┌────────▼──────────────────────────────┐
│           cocod daemon                 │
│    (Cashu wallet implementation)       │
│                                        │
│  Manages:                              │
│   • Nostr identities (nsec/npub)       │
│   • Cashu mints (multi-mint)           │
│   • Proofs & token minting/redeeming   │
│   • NIP-60 / NIP-61 compliance         │
│   • Lightning invoices (BOLT-11)       │
└────────────────────────────────────────┘
```

### Limitations of the current setup

1. **Single wallet backend** — routstrd is hard-coupled to `cocod`; there's no abstraction for alternative wallet backends
2. **No Lightning-native funding** — users must bring Cashu tokens or generate BOLT-11 invoices and pay them externally; there's no "one-click fund" from a Lightning wallet
3. **No balance monitoring** — routstrd doesn't auto-refill or trigger top-ups based on balance thresholds
4. **Wallet is always local** — the daemon must run cocod locally; no remote wallet support

---

## Why NWC in routstrd

### 1. Onboarding Friction

Right now, a routstrd user must:
1. Acquire sats (somehow)
2. Use a separate tool to fund their cocod wallet via Cashu token or Lightning invoice
3. Run routstrd with sufficient balance

With NWC, they could connect their existing Lightning wallet (Alby Hub, Zeus, Mutiny, etc.) and fund routstrd's wallet **in one click** from the same interface.

### 2. Auto-Topup

routstr-chat already has auto-refill logic. That logic belongs in routstrd — the daemon that actually manages the wallet. Moving it server-side means:
- Balance monitoring happens even when no frontend is open
- Top-ups trigger even for CLI/headless usage
- Multiple frontend clients (chat, mobile, other apps) all benefit from the same daemon logic

### 3. Independent of cocod

NWC could serve as a **funding source** for any wallet backend:
- `cocod` (current): NWC pays a BOLT-11 invoice to fund the Cashu wallet
- Future Cashu implementations: same pattern
- Direct NWC wallet: skip Cashu entirely and pay providers directly from the Lightning wallet (with appropriate budget controls)

### 4. Consistent UX with routstr-chat

routstr-chat already uses NWC. If routstrd also supports NWC, the experience is unified: users connect once, and both the daemon and the chat UI can use the same wallet connection.

---

## Architecture Proposal

### High-Level Design

```
                     ┌───────────────────────┐
                     │   User's Lightning     │
                     │   Wallet (Alby Hub,    │
                     │   Zeus, Mutiny, etc.)  │
                     └───────────┬───────────┘
                                 │  NIP-47 over Nostr relays
                                 │  (encrypted requests/responses)
                     ┌───────────▼───────────┐
                     │   @getalby/bitcoin-    │  (browser only — stays in chat)
                     │   connect-react        │
                     └───────────────────────┘
                     
                     ┌───────────────────────┐
                     │   nostr-core / raw     │  NEW: Node.js/Bun compatible
                     │   NWC client           │  routstrd's NWC adapter
                     └───────────┬───────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
     ┌────────▼───────┐  ┌──────▼──────┐  ┌───────▼────────┐
     │  NWC funding   │  │  cocod      │  │  Future wallet  │
     │  adapter       │  │  adapter    │  │  adapters       │
     │  (direct LN)   │  │  (Cashu)    │  │                 │
     └────────┬───────┘  └──────┬──────┘  └───────┬────────┘
              │                  │                  │
     ┌────────▼──────────────────▼──────────────────▼────────┐
     │                   Wallet Adapter Interface             │
     │                                                        │
     │  getBalances() → Record<paymentMethod, amount>         │
     │  sendPayment(invoice, amount) → { preimage, fees }     │
     │  receivePayment(amount) → invoice                      │
     │  getStatus() → connected|disconnected|locked           │
     │  connect(connectionString) → void                      │
     │  disconnect() → void                                   │
     └────────────────────────────────────────────────────────┘
              │
     ┌────────▼────────────────────────────────────────┐
     │              routstrd Routing Engine              │
     │  • Selects cheapest provider per model           │
     │  • Deducts from wallet balance                   │
     │  • Triggers auto-refill when below threshold     │
     └─────────────────────────────────────────────────┘
```

### Two NWC Modes

#### Mode A: NWC as Funding Source for Cashu (recommended)

routstrd keeps using cocod for Cashu operations. NWC is a *funding source* — it pays BOLT-11 invoices generated by the Cashu mint to fund the wallet.

```
  [Balance low]
       │
       ▼
  routstrd creates BOLT-11 invoice via Cashu mint ("mint new tokens")
       │
       ▼
  routstrd pays that invoice via NWC
       │
       ▼
  Cashu mint issues tokens → balance increases
```

This is **exactly** what `routstr-chat/lib/nwcPayment.ts` already does: `createLightningInvoice` → `sendPayment` → `mintTokensFromPaidInvoice`.

#### Mode B: NWC as Standalone Wallet (future)

Skip Cashu entirely. routstrd pays providers directly from the Lightning wallet via NWC. This requires:
- A provider that accepts Lightning payments (or an L402-like scheme)
- Budget/rate limiting on the NWC connection (built into NIP-47)
- No token management overhead

This is simpler for users who don't need Cashu's privacy properties.

---

## Configuration

### New routstrd config fields

```json
// ~/.routstrd/config.json
{
  "port": 8008,
  "provider": null,
  "mode": "apikeys",
  
  // NEW — NWC configuration
  "nwc": {
    // Mode A: NWC funds a Cashu wallet
    "mode": "funding_source",
    
    // NWC connection string (nostr+walletconnect://...)
    "connectionString": "nostr+walletconnect://b889ff5b...?relay=wss://relay.getalby.com/v1&secret=71a8c14c...",
    
    // Auto-refill settings (in sats)
    "autoRefill": {
      "enabled": true,
      "threshold": 500,    // refill when Cashu balance < 500 sats
      "amount": 1000,      // refill 1000 sats at a time
      "cooldownMs": 300000 // 5 minutes between refills
    }
  }
}
```

### CLI commands

```sh
# Set up NWC connection
routstrd nwc connect <connection-string>
routstrd nwc connect                            # interactive: paste or scan QR

# Status
routstrd nwc status                             # connected/disconnected, alias, balance

# Manage
routstrd nwc disconnect
routstrd nwc auto-refill on --threshold 500 --amount 1000
routstrd nwc auto-refill off

# Manual operations
routstrd nwc fund <amount>                      # manually fund wallet from NWC
routstrd nwc pay-invoice <bolt11>               # pay a specific invoice via NWC
```

---

## NWC Wallet Adapter

### Dependency: `nostr-core`

For Bun/Node.js compatibility, use `nostr-core` instead of `@getalby/bitcoin-connect-react`:

```sh
bun add nostr-core
```

### Adapter Implementation Sketch

```ts
// src/daemon/wallet/nwc-adapter.ts

import { NWC } from "nostr-core";

export interface NwcConfig {
  connectionString: string;
  autoRefill?: {
    enabled: boolean;
    threshold: number;   // sats
    amount: number;      // sats
    cooldownMs: number;  // milliseconds
  };
}

export interface NwcWalletAdapter {
  connect(): Promise<{
    alias: string;
    pubkey: string;
    methods: string[];
  }>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getBalance(): Promise<number>;  // sats
  getInfo(): Promise<{
    alias: string;
    pubkey: string;
    network: string;
    methods: string[];
  }>;
  payInvoice(invoice: string, amount?: number): Promise<{
    preimage: string;
    fees_paid?: number;
  }>;
  makeInvoice(params: {
    amount: number;       // msats
    description?: string;
  }): Promise<{ invoice: string }>;
  getBudget(): Promise<{
    max_amount: number;
    budget_renewal: string;
    remaining: number;
  } | null>;
}

export function createNwcAdapter(config: NwcConfig): NwcWalletAdapter {
  let nwc: NWC | null = null;

  return {
    async connect() {
      nwc = new NWC(config.connectionString);
      nwc.replyTimeout = 60000;    // 60s wallet reply timeout
      nwc.publishTimeout = 10000;  // 10s relay publish timeout
      
      await nwc.connect();
      const info = await nwc.getInfo();
      
      return {
        alias: info.alias || "Unknown Wallet",
        pubkey: info.pubkey || "",
        methods: info.methods || [],
      };
    },

    async disconnect() {
      if (nwc) {
        nwc.close();
        nwc = null;
      }
    },

    isConnected() {
      return nwc !== null;
    },

    async getBalance() {
      if (!nwc) throw new Error("NWC not connected");
      const { balance } = await nwc.getBalance();
      // balance is in msats from NIP-47; convert to sats
      return Math.floor(balance / 1000);
    },

    async getInfo() {
      if (!nwc) throw new Error("NWC not connected");
      return nwc.getInfo();
    },

    async payInvoice(invoice, amount) {
      if (!nwc) throw new Error("NWC not connected");
      return nwc.payInvoice(invoice, amount);
    },

    async makeInvoice(params) {
      if (!nwc) throw new Error("NWC not connected");
      return nwc.makeInvoice(params);
    },

    async getBudget() {
      if (!nwc) throw new Error("NWC not connected");
      try {
        return await nwc.getBudget();
      } catch {
        return null; // budget info not always available
      }
    },
  };
}
```

### Integration with existing Wallet Adapter

The existing `createWalletAdapter()` can be extended to accept an NWC funding source:

```ts
// src/daemon/wallet/index.ts (modified)

export async function createWalletAdapter(options: {
  cocodPath?: string | null;
  walletClient?: CocodClient;
  nwcFundingSource?: NwcWalletAdapter;     // NEW
  nwcAutoRefill?: AutoRefillConfig;         // NEW
}) {
  const client = /* ... existing cocod setup ... */;
  const nwc = options.nwcFundingSource;
  
  const walletAdapter = {
    // ... existing methods ...
    
    // NEW methods
    async fundFromNWC(amount: number): Promise<{
      success: boolean;
      invoice: string;
      preimage?: string;
      error?: string;
    }> {
      if (!nwc || !nwc.isConnected()) {
        throw new Error("NWC not connected");
      }
      
      // Create bolt11 invoice via cocod to fund the Cashu wallet
      const invoice = await client.receiveBolt11(amount, activeMintUrl!);
      
      // Pay it via NWC
      const { preimage } = await nwc.payInvoice(invoice, amount);
      
      return { success: true, invoice, preimage };
    },
    
    getNwcStatus() {
      return {
        connected: nwc?.isConnected() ?? false,
        balance: null, // fetched async
      };
    }
  };
  
  // Auto-refill loop (if configured)
  if (options.nwcAutoRefill?.enabled) {
    startAutoRefillLoop(walletAdapter, options.nwcAutoRefill);
  }
  
  return walletAdapter;
}
```

---

## Auto-Refill / Auto-Topup

### Moving from routstr-chat to routstrd

Currently, `useAutoRefill.ts` lives in routstr-chat (the browser). The same logic should move to routstrd so it runs regardless of whether a frontend is open.

```ts
// src/daemon/wallet/auto-refill.ts

import type { CocodClient } from "./cocod-client";
import type { NwcWalletAdapter } from "./nwc-adapter";
import { logger } from "../../utils/logger";

export interface AutoRefillConfig {
  threshold: number;   // sats
  amount: number;      // sats
  cooldownMs: number;  // milliseconds
}

export function startAutoRefillLoop(
  cocod: CocodClient,
  nwc: NwcWalletAdapter,
  config: AutoRefillConfig,
  intervalMs: number = 5000,
): () => void {
  let lastRefillAt = 0;
  let running = true;
  let timeout: ReturnType<typeof setInterval> | null = null;

  async function checkAndRefill() {
    if (!running) return;
    if (!nwc.isConnected()) return;

    const now = Date.now();
    if (now - lastRefillAt < config.cooldownMs) return;

    try {
      const balances = await cocod.getBalances();
      const totalBalance = Object.values(balances).reduce(
        (sum, b) => sum + (typeof b === "number" ? b : (b as any).sats ?? 0),
        0,
      );

      if (totalBalance < config.threshold) {
        logger.log(
          `[auto-refill] Balance ${totalBalance} sats < threshold ${config.threshold}. Refilling ${config.amount} sats...`,
        );

        // Create bolt11 invoice from cocod
        const activeMints = await cocod.listMints();
        const mintUrl = activeMints[0];
        if (!mintUrl) {
          logger.error("[auto-refill] No active mint configured");
          return;
        }

        const invoice = await cocod.receiveBolt11(config.amount, mintUrl);
        const { preimage } = await nwc.payInvoice(invoice, config.amount);

        logger.log(
          `[auto-refill] Successfully refilled ${config.amount} sats. Preimage: ${preimage}`,
        );
        lastRefillAt = now;
      }
    } catch (error) {
      logger.error("[auto-refill] Error:", error);
    }
  }

  // Check immediately, then on interval
  checkAndRefill();
  timeout = setInterval(checkAndRefill, intervalMs);

  return () => {
    running = false;
    if (timeout) clearInterval(timeout);
  };
}
```

---

## Tradeoffs: NWC vs cocod (Cashu-native)

| Dimension | cocod (Cashu-native) | NWC (Lightning-native) |
|-----------|---------------------|------------------------|
| **Privacy** | Strong: Chaumian ecash, unlinkable tokens | Weak: all payments visible to wallet provider |
| **Setup** | Complex: requires running cocod, managing mints | Simple: paste a connection string |
| **Funding** | Manual: import Cashu tokens or pay invoices externally | Automatic: funds cascade from connected Lightning wallet |
| **Reliability** | Depends on Cashu mint uptime | Depends on Nostr relay uptime |
| **Fees** | Cashu mint fees (typically low) | Lightning routing fees (variable) |
| **Ecosystem** | Growing but niche (Cashu ecosystem) | Mature (Lightning Network, 100+ wallets) |
| **Browser support** | Requires wallet extension or token input | Works with any NWC-compatible wallet |
| **Budget controls** | None built in | NIP-47 supports per-connection budgets, spend limits, renewal periods |
| **Dependencies** | Must run cocod process | Need a Nostr relay (can be public) |
| **Multi-mint** | Supported natively by cocod | N/A (Lightning is single-network) |

### Recommended Strategy

**Use both, with NWC as the funding bridge.**

```
Lightning Wallet (NWC) ──funds──▶ cocod Cashu Wallet ──pays──▶ LLM Providers
                                  ▲
                                  │  (privacy, multi-mint,
                                  │   token portability)
                                  │
                           Users hold sats in
                           Cashu tokens for
                           day-to-day use
```

The NWC connection only activates when the Cashu balance runs low — it's a "refill line," not the primary payment rail. This preserves Cashu's privacy properties for routine LLM payments while making the funding experience seamless.

---

## Implementation Plan

### Phase 1: NWC as Funding Source for cocod (1-2 days)

1. **Add `nostr-core` dependency** to routstrd
2. **Create `src/daemon/wallet/nwc-adapter.ts`** — NWC client wrapper
3. **Extend `createWalletAdapter()`** to accept an optional NWC adapter
4. **Add auto-refill loop** in the daemon startup
5. **Add config fields** for NWC connection string and auto-refill settings
6. **Add CLI commands**: `routstrd nwc connect`, `routstrd nwc status`, etc.

### Phase 2: Shared NWC Connection (1 day)

7. **Expose NWC status** via daemon HTTP API so routstr-chat can read it
8. **Sync** — if NWC is connected in routstrd, routstr-chat doesn't need its own connection
9. **Unify settings** — auto-refill configured once, in routstrd config

### Phase 3: Standalone NWC Mode (future, 2-3 days)

10. **Skip Cashu** — NWC adapter becomes the primary wallet backend
11. **Provider integration** — providers that accept Lightning payments directly
12. **Budget controls** — leverage NIP-47 budget features for per-model spend limits

---

## Appendix: NWC Connection Flow

```
┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│   routstrd    │     │  Nostr Relay  │     │  Alby Hub /  │
│   (client)    │     │               │     │  Wallet Svc  │
└──────┬───────┘     └───────┬───────┘     └──────┬───────┘
       │                     │                     │
       │  1. User provides   │                     │
       │  connection string  │                     │
       │  nostr+walletconnect://<pk>?relay=...     │
       │                     │                     │
       │  2. Connect to relay (WebSocket)          │
       │────────────────────▶│                     │
       │                     │                     │
       │  3. Subscribe to NIP-47 responses         │
       │  (kind 23195, p=<my-pubkey>)              │
       │────────────────────▶│                     │
       │                     │                     │
       │  4. NIP-47 request event                  │
       │  (kind 23194, encrypted, p=<wallet-pk>)   │
       │────────────────────▶│                     │
       │                     │  5. Relay forwards  │
       │                     │────────────────────▶│
       │                     │                     │ 6. Wallet decrypts,
       │                     │                     │    authorizes, pays
       │                     │                     │
       │                     │  7. Response event  │
       │                     │◀────────────────────│
       │  8. Receive response│                     │
       │◀────────────────────│                     │
       │                     │                     │
       │  9. Parse & return  │                     │
       │  (preimage, balance,│                     │
       │   invoice, etc.)    │                     │
       │                     │                     │
```

## Appendix: Key Files Reference

### routstr-chat (existing NWC integration)

| File | Purpose |
|------|---------|
| `components/bitcoin-connect/BitcoinConnectClient.tsx` | NWC init with `@getalby/bitcoin-connect-react` |
| `hooks/useBitcoinConnect.tsx` | Connection state, balance, connect/disconnect |
| `lib/nwcPayment.ts` | `payWithNWC()` — invoice creation → NWC payment → Cashu token minting |
| `hooks/useAutoRefill.ts` | Balance monitoring + auto-refill trigger |
| `components/settings/NWCWalletManager.tsx` | Settings UI for Connect/Disconnect |
| `components/bitcoin-connect/BitcoinConnectStatusRow.tsx` | Compact inline status widget |

### routstrd (new NWC integration target)

| File | Purpose |
|------|---------|
| `src/daemon/wallet/index.ts` | `createWalletAdapter()` — extend to accept NWC |
| `src/daemon/wallet/cocod-client.ts` | `CocodClient` — stays as-is for Cashu ops |
| `src/daemon/wallet/nwc-adapter.ts` | **NEW** — NWC client wrapper using `nostr-core` |
| `src/daemon/wallet/auto-refill.ts` | **NEW** — server-side auto-refill loop |
| `src/daemon/config-store.ts` | Extend config types to include NWC fields |
| `src/utils/config.ts` | `RoutstrdConfig` type — add `nwc` field |
| `src/cli.ts` (or new nwc command module) | **NEW** — `routstrd nwc *` CLI commands |
