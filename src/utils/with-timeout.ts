/**
 * Rejects when `timeoutMs` elapses before `promise` settles.
 *
 * Used to bound requests that may otherwise wait forever — notably NWC calls
 * whose underlying library applies its own timeout only after a support/encryption
 * handshake that can itself hang on a stale relay subscription.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = "Operation timed out",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
