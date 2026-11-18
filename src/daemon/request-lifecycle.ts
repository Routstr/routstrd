import { readFile, writeFile, rename } from "node:fs/promises";
import type { RequestLifecycleDriver } from "@routstr/sdk";

/** The PID lock guarantees one daemon per DB. Never reconcile unrelated SDK owners. */
export async function initializeDaemonLifecycle(
  driver: RequestLifecycleDriver,
  dbPath: string,
): Promise<string> {
  await driver.migrate();
  const ownerFile = `${dbPath}.daemon-lifecycle-owner`;
  let previousOwner: string | undefined;
  try {
    previousOwner = (await readFile(ownerFile, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previousOwner) await driver.reconcileInterrupted(previousOwner);
  const owner = `routstrd:${globalThis.crypto.randomUUID()}`;
  const temporary = `${ownerFile}.${process.pid}.tmp`;
  await writeFile(temporary, owner, { mode: 0o600 });
  await rename(temporary, ownerFile);
  return owner;
}
