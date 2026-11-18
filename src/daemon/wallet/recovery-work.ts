/** A timed-out wait is not cancellation: retain work until it actually settles. */
export type RecoveryWork = Map<string, Promise<unknown>>;
export const recoveryKey = (kind: string, id: string): string => `${kind}:${id}`;

export function trackRecovery<T>(work: RecoveryWork, key: string, promise: Promise<T>): Promise<T> {
  work.set(key, promise);
  const clear = () => { if (work.get(key) === promise) work.delete(key); };
  void promise.then(clear, clear);
  return promise;
}

export class RecoveryWaitTimeout extends Error {
  constructor() { super("Timed out waiting for recovery; underlying work is still tracked"); }
}

export async function waitForRecoveryWork<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RecoveryWaitTimeout()), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Drain actual work, including work registered while an earlier task settles. */
export async function drainRecoveryWork(work: RecoveryWork): Promise<void> {
  while (work.size) await Promise.allSettled([...work.values()]);
}

/** Timeout reports incomplete disposal; actual cleanup continues safely. */
export function createRecoveryDisposer(
  quiesce: () => void,
  settle: () => Promise<void>,
  close: () => Promise<void>,
  timeoutMs = 30_000,
): () => Promise<void> {
  let disposal: Promise<void> | undefined;
  return async () => {
    quiesce();
    disposal ??= (async () => { await settle(); await close(); })();
    await waitForRecoveryWork(disposal, timeoutMs);
  };
}
