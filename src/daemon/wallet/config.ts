import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";

interface WalletConfig {
  version?: number;
  mnemonic?: string;
  encrypted?: boolean;
  createdAt?: string;
}

export function initializeWalletDirectory(walletDir: string): {
  created: boolean;
  mnemonic: string;
} {
  const configPath = join(walletDir, "config.json");
  mkdirSync(walletDir, { recursive: true, mode: 0o700 });
  chmodSync(walletDir, 0o700);

  if (existsSync(configPath)) {
    chmodSync(configPath, 0o600);
    return { created: false, mnemonic: readWalletMnemonic(walletDir) };
  }

  const mnemonic = generateMnemonic(wordlist);
  const config: WalletConfig = {
    version: 1,
    mnemonic,
    encrypted: false,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  return { created: true, mnemonic };
}

export function readWalletMnemonic(walletDir: string): string {
  const configPath = join(walletDir, "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Wallet is not initialized at ${walletDir}`);
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as WalletConfig;
  if (config.encrypted) {
    throw new Error("Encrypted wallet backup is not supported yet.");
  }
  if (!config.mnemonic?.trim()) {
    throw new Error(`Wallet config at ${configPath} does not contain a mnemonic`);
  }
  return config.mnemonic;
}
