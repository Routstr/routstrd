export class WalletRecoveryBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletRecoveryBusyError";
  }
}

/**
 * Coordinates public wallet mutations with destructive counter restoration.
 * Admission is synchronous, so no mutation can enter between the recovery
 * availability check and recovery becoming exclusive.
 */
export class RecoveryGate {
  private activeMutations = 0;
  private recovering = false;

  async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.recovering) {
      throw new WalletRecoveryBusyError(
        "Wallet recovery is in progress; try again when it completes.",
      );
    }

    this.activeMutations += 1;
    try {
      return await operation();
    } finally {
      this.activeMutations -= 1;
    }
  }

  async runRecovery<T>(operation: () => Promise<T>): Promise<T> {
    if (this.recovering) {
      throw new WalletRecoveryBusyError("Wallet recovery is already in progress.");
    }
    if (this.activeMutations > 0) {
      throw new WalletRecoveryBusyError(
        "Cannot start wallet recovery while another wallet operation is in progress.",
      );
    }

    this.recovering = true;
    try {
      return await operation();
    } finally {
      this.recovering = false;
    }
  }
}
