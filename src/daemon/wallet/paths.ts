import { join } from "path";

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

/** Root directory for routstrd state. Evaluated lazily so env overrides work in tests. */
export function routstrdConfigDir(): string {
  return process.env.ROUTSTRD_DIR || join(homeDir(), ".routstrd");
}

/** Canonical directory for the in-process Cashu wallet. */
export function walletDir(): string {
  return process.env.ROUTSTRD_WALLET_DIR || join(routstrdConfigDir(), "wallet");
}

/** Lock owned by an in-process routstrd wallet instance. */
export function walletPidPath(): string {
  return process.env.ROUTSTRD_WALLET_PID || join(walletDir(), "wallet.pid");
}

/** Legacy external cocod directory. This is not the routstrd wallet directory. */
export function legacyCocodDir(): string {
  return process.env.COCOD_DIR || join(homeDir(), ".cocod");
}

export function legacyCocodSocketPath(): string {
  return process.env.COCOD_SOCKET || join(legacyCocodDir(), "cocod.sock");
}

export function legacyCocodPidPath(): string {
  return process.env.COCOD_PID || join(legacyCocodDir(), "cocod.pid");
}
