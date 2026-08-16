import { existsSync, readFileSync } from "fs";
import { join } from "path";
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
