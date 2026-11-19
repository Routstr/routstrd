import { recoveryKey, trackRecovery, waitForRecoveryWork, type RecoveryWork } from "./recovery-work";

/** A foreground deadline must not release a monetary operation's ownership.
 * Reuse the same work for duplicate receives, and include it in shutdown drain.
 */
export async function waitForReceive<T>(
  outstanding: RecoveryWork,
  tokenHash: string,
  receive: () => Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  const key = recoveryKey("foreground-receive", tokenHash);
  let work = outstanding.get(key) as Promise<T> | undefined;
  if (!work) {
    work = Promise.resolve().then(receive);
    trackRecovery(outstanding, key, work);
  }
  return waitForRecoveryWork(work, timeoutMs);
}
