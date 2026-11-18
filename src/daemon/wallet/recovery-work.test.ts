import { expect, it } from "bun:test";
import { createRunQueue } from "./coco-client";
import { createRecoveryDisposer, drainRecoveryWork, trackRecovery } from "./recovery-work";

it("incomplete shutdown retains resources until late writes settle; retries join disposal", async () => {
  const work = new Map<string, Promise<unknown>>();
  let finish!: () => void;
  const events: string[] = [];
  trackRecovery(work, "mint:q", new Promise<void>(r => { finish = r; }).then(() => { events.push("write"); }));
  const dispose = createRecoveryDisposer(() => {}, () => drainRecoveryWork(work), async () => { events.push("close"); }, 5);
  await expect(dispose()).rejects.toThrow("Timed out");
  expect(events).toEqual([]);
  finish();
  await dispose();
  expect(events).toEqual(["write", "close"]);
  await dispose();
  expect(events).toEqual(["write", "close"]);
});

it("shutdown drains active queue work and queued callbacks reject before touching DB", async () => {
  const queue = createRunQueue();
  let disposed = false;
  let finish!: () => void;
  const events: string[] = [];
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const active = queue(() => new Promise<void>(r => { finish = r; started(); }).then(() => { events.push("write"); }));
  await ready;
  const queued = queue(async () => {
    if (disposed) throw new Error("Wallet is shutting down");
    events.push("unexpected");
  });
  const rejected = queued.catch(error => error);
  const dispose = createRecoveryDisposer(() => { disposed = true; }, () => queue.drain(), async () => { events.push("close"); }, 5);
  await expect(dispose()).rejects.toThrow("Timed out");
  finish();
  await active;
  expect((await rejected).message).toContain("shutting down");
  await dispose();
  expect(events).toEqual(["write", "close"]);
});
