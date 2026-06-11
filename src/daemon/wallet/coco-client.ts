import { initializeCoco, getEncodedToken } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { mnemonicToSeedSync } from "@scure/bip39";
import type { CocodClient, CocodState } from "./cocod-client";
import { logger } from "../../utils/logger";

const CONFIG_DIR =
  process.env.COCOD_DIR ||
  `${process.env.HOME || process.env.USERPROFILE || ""}/.cocod`;

const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DB_PATH = join(CONFIG_DIR, "coco.db");

interface CocodConfig {
  mnemonic: string;
  encrypted: boolean;
}

function loadMnemonic(): string {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(
      `Config file not found at ${CONFIG_FILE}. Run 'routstrd onboard' first.`,
    );
  }
  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as CocodConfig;
  if (config.encrypted) {
    throw new Error(
      "Encrypted wallets are not supported yet. Please use an unencrypted wallet.",
    );
  }
  return config.mnemonic;
}

async function seedGetter(): Promise<Uint8Array> {
  const mnemonic = loadMnemonic();
  return mnemonicToSeedSync(mnemonic);
}

export async function createCocoClient(): Promise<CocodClient> {
  const database = new Database(DB_PATH);
  const repo = new SqliteRepositories({ database });
  await repo.init();

  const coco = await initializeCoco({
    repo,
    seedGetter,
  });

  return {
    async ping(): Promise<boolean> {
      try {
        await coco.wallet.balances.total();
        return true;
      } catch {
        return false;
      }
    },

    async getStatus(): Promise<CocodState> {
      try {
        await coco.wallet.balances.total();
        return "UNLOCKED";
      } catch {
        return "ERROR";
      }
    },

    async unlock(_passphrase: string): Promise<string> {
      // coco-core does not support passphrase locking.
      // Wallet access is controlled via the mnemonic in ~/.cocod/config.json.
      return "wallet does not require unlocking";
    },

    async getBalances(): Promise<Record<string, number>> {
      const byMint = await coco.wallet.balances.byMint();
      return Object.fromEntries(
        Object.entries(byMint).map(([mintUrl, snapshot]) => [
          mintUrl,
          snapshot.spendable,
        ]),
      );
    },

    async receiveCashu(token: string): Promise<string> {
      await coco.wallet.receive(token);
      return "Token received successfully";
    },

    async receiveBolt11(amount: number, mintUrl?: string): Promise<string> {
      const mints = await coco.mint.getAllTrustedMints();
      const targetMint = mintUrl || mints[0]?.mintUrl;
      if (!targetMint) {
        throw new Error("No trusted mint available for Lightning invoice");
      }
      const op = await coco.ops.mint.prepare({
        mintUrl: targetMint,
        amount,
        method: "bolt11",
      });
      if (!("request" in op)) {
        throw new Error("mint prepare did not return a payment request");
      }
      return op.request as string;
    },

    async sendCashu(amount: number, mintUrl?: string): Promise<string> {
      const mints = await coco.mint.getAllTrustedMints();
      const targetMint = mintUrl || mints[0]?.mintUrl;
      if (!targetMint) {
        throw new Error("No trusted mint available for sending");
      }
      const prepared = await coco.ops.send.prepare({
        mintUrl: targetMint,
        amount,
      });
      try {
        const { token } = await coco.ops.send.execute(prepared.id);
        return getEncodedToken(token);
      } catch (error) {
        await coco.ops.send.cancel(prepared.id);
        throw error;
      }
    },

    async sendBolt11(invoice: string, mintUrl?: string): Promise<string> {
      const mints = await coco.mint.getAllTrustedMints();
      const targetMint = mintUrl || mints[0]?.mintUrl;
      if (!targetMint) {
        throw new Error("No trusted mint available for Lightning payment");
      }
      const prepared = await coco.ops.melt.prepare({
        mintUrl: targetMint,
        method: "bolt11",
        methodData: { invoice },
      });
      try {
        await coco.ops.melt.execute(prepared.id);
        return "Payment sent successfully";
      } catch (error) {
        await coco.ops.melt.cancel(prepared.id);
        throw error;
      }
    },

    async listMints(): Promise<string[]> {
      const mints = await coco.mint.getAllTrustedMints();
      return mints.map((m) => m.mintUrl);
    },

    async addMint(url: string): Promise<string> {
      await coco.mint.addMint(url, { trusted: true });
      return `Mint ${url} added successfully`;
    },

    async getMintInfo(url: string): Promise<unknown> {
      return coco.mint.getMintInfo(url);
    },
  };
}
