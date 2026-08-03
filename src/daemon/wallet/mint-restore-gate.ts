export class WalletRestoreBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletRestoreBusyError";
  }
}

/**
 * Serializes an on-demand NUT-09 mint restore against public wallet mutations.
 *
 * Restore overwrites proof counters for a keyset, so a mutation that allocates
 * outputs concurrently could reuse counters and burn proofs. Admission is
 * synchronous on purpose: no mutation can slip in between the availability
 * check and restore becoming exclusive.
 *
 * This is separate from the startup `RecoveryGate` in `coco-client.ts`, which
 * holds value-moving calls until startup sweeps finish. This gate covers an
 * explicit user-triggered restore on an already-running daemon.
 */
export class MintRestoreGate {
  private activeMutations = 0;
  private restoring = false;

  async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.restoring) {
      throw new WalletRestoreBusyError(
        "Wallet restore is in progress; try again when it completes.",
      );
    }

    this.activeMutations += 1;
    try {
      return await operation();
    } finally {
      this.activeMutations -= 1;
    }
  }

  async runRestore<T>(operation: () => Promise<T>): Promise<T> {
    if (this.restoring) {
      throw new WalletRestoreBusyError(
        "Wallet restore is already in progress.",
      );
    }
    if (this.activeMutations > 0) {
      throw new WalletRestoreBusyError(
        "Cannot start a wallet restore while another wallet operation is in progress.",
      );
    }

    this.restoring = true;
    try {
      return await operation();
    } finally {
      this.restoring = false;
    }
  }
}
