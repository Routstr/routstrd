import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { walletDir as defaultWalletDir } from "./paths";

export interface WalletConfigFile {
  version?: number;
  mnemonic?: string;
  encrypted?: boolean;
  createdAt?: string;
  defaultMintUrl?: string;
}

/**
 * Read the plaintext BIP-39 mnemonic from the wallet config file.
 *
 * Returns null when the wallet is not initialized yet or when the config is
 * malformed/encrypted. Encrypted wallets are not supported, so their mnemonic
 * must not be used for key derivation.
 */
export function readWalletMnemonic(walletDir = defaultWalletDir()): string | null {
  const configFile = join(walletDir, "config.json");
  if (!existsSync(configFile)) return null;

  let config: WalletConfigFile;
  try {
    config = JSON.parse(readFileSync(configFile, "utf-8")) as WalletConfigFile;
  } catch {
    return null;
  }

  if (config.encrypted) return null;
  return typeof config.mnemonic === "string" && config.mnemonic.trim()
    ? config.mnemonic.trim()
    : null;
}

/**
 * Create the canonical wallet (a config.json holding a fresh BIP-39 mnemonic)
 * when it does not exist yet. An existing wallet is never modified.
 *
 * Concurrent initializers are safe: the process that loses the probe/write
 * race gets EEXIST from the exclusive create and treats it as "already
 * initialized", keeping the winner's mnemonic.
 *
 * Returns true when this call created the wallet.
 */
export function initializeWallet(
  walletDir = defaultWalletDir(),
  log: (message: string) => void = console.log,
): boolean {
  const walletConfig = join(walletDir, "config.json");

  // The wallet directory and config contain the plaintext seed phrase. Correct
  // permissions on existing installations as well as newly created ones.
  mkdirSync(walletDir, { recursive: true, mode: 0o700 });
  chmodSync(walletDir, 0o700);

  if (existsSync(walletConfig)) {
    chmodSync(walletConfig, 0o600);
    log("Wallet already initialized.");
    return false;
  }

  const mnemonic = generateMnemonic(wordlist);
  const config = {
    version: 1,
    mnemonic,
    encrypted: false,
    createdAt: new Date().toISOString(),
  };
  try {
    writeFileSync(walletConfig, JSON.stringify(config, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Lost the race with a concurrent initializer; its mnemonic is
      // authoritative, so this is not an error.
      chmodSync(walletConfig, 0o600);
      log("Wallet already initialized.");
      return false;
    }
    throw error;
  }
  log(`Initialized. Mnemonic: ${mnemonic}`);
  log("IMPORTANT: Write down this mnemonic and keep it safe!");
  return true;
}
