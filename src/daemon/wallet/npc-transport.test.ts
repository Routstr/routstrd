import { describe, expect, it } from "bun:test";
import { finalizeEvent } from "nostr-tools";
import { JWTAuthProvider, NPCClient } from "npubcash-sdk";
// Use require so another test's mock.module of the ESM plugin cannot hide the
// real dependency exercised here. Both shipped builds carry the same patch.
const cjs = require("coco-cashu-plugin-npc") as typeof import("coco-cashu-plugin-npc");
const esm = await import(require.resolve("coco-cashu-plugin-npc").replace(/index\.cjs$/, "index.js")) as typeof cjs;

const signer = async (event: Parameters<typeof finalizeEvent>[0]) =>
  finalizeEvent(event, new Uint8Array(32).fill(1));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(endpoint: "auth" | "quotes", stall: "headers" | "body") {
  let stalled = true;
  const entered = deferred<void>();
  const canceled = deferred<void>();
  const release = deferred<Response>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const isAuth = path.endsWith("/auth/nip98");
      if (!stalled || (endpoint === "auth") !== isAuth) {
        return Response.json(isAuth
          ? { data: { token: "test-token" } }
          : { data: { quotes: [] }, metadata: { total: 0 } });
      }
      entered.resolve();
      if (stall === "headers") return release.promise;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); },
        cancel() { canceled.resolve(); },
      }), { headers: { "content-type": "application/json" } });
    },
  });
  return { url: server.url.origin, entered, canceled, recover() { stalled = false; },
    async close() { release.resolve(Response.json({})); await server.stop(true); } };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("NPC work did not settle")), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

describe("patched NPC HTTP transport", () => {
  for (const endpoint of ["auth", "quotes"] as const) {
    for (const stall of ["headers", "body"] as const) {
      it(`aborts ${endpoint} stalled at ${stall} and permits retry`, async () => {
        const f = fixture(endpoint, stall);
        const options = { requestTimeoutMs: 100 };
        const client = new NPCClient(f.url, new JWTAuthProvider(f.url, signer, undefined, options), options);
        try {
          const result = client.getQuotesSince(0);
          const rejected = result.then(() => { throw new Error("stalled request unexpectedly succeeded"); }, (error: unknown) => { expect(error).toBeInstanceOf(Error); });
          await within(f.entered.promise);
          await within(rejected);
          if (stall === "body") await within(f.canceled.promise);
          // A deadline must not permanently poison later requests.
          f.recover();
          expect(await within(client.getQuotesSince(0))).toEqual([]);
        } finally { await f.close(); }
      });

      for (const [build, { NPCPlugin }] of [["ESM", esm], ["CJS", cjs]] as const) {
      it(`shutdown aborts ${build} plugin ${endpoint} work stalled at ${stall}`, async () => {
        const f = fixture(endpoint, stall);
        const plugin = new NPCPlugin(f.url, signer, { requestTimeoutMs: 60_000 });
        let api: { sync(): Promise<void> } | undefined;
        const cleanup = plugin.onInit({
          registerExtension(_key: string, value: unknown) { api = value as typeof api; },
          services: { paymentRequestService: {}, mintOperationService: {}, mintService: {} },
        } as unknown as Parameters<typeof plugin.onInit>[0]);
        plugin.onReady();
        try {
          const sync = api!.sync();
          await within(f.entered.promise);
          // Much shorter than the configured request deadline: shutdown must
          // abort, not merely wait for the timer or abandon a live request.
          await within(cleanup());
          await within(sync);
          if (stall === "body") await within(f.canceled.promise);
          expect(plugin.getStatus().isSyncing).toBe(false);
        } finally { await cleanup(); await f.close(); }
      });
      }
    }
  }

  it("preserves successful authentication, pagination and JSON bodies", async () => {
    const offsets: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/auth/nip98")) {
        expect(request.headers.get("authorization")).toStartWith("Nostr ");
        return Response.json({ data: { token: "jwt" } });
      }
      expect(request.headers.get("authorization")).toBe("Bearer jwt");
      offsets.push(url.searchParams.get("offset")!);
      return Response.json({ data: { quotes: [{ quoteId: offsets.at(-1) }] }, metadata: { total: 51 } });
    } });
    try {
      const client = new NPCClient(server.url.origin, new JWTAuthProvider(server.url.origin, signer));
      expect(await client.getQuotesSince(0)).toHaveLength(2);
      expect(offsets).toEqual(["0", "50"]);
    } finally { await server.stop(true); }
  });
});
