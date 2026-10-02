/**
 * In-process Cashu mint for integration tests.
 *
 * Implements just enough of NUT-01/02/04/06/07/09 to drive a real coco
 * `Manager` against real HTTP: keyset publication, bolt11 mint quotes, minting
 * blinded outputs with a real secp256k1 blind signature, NUT-09 restore and
 * NUT-07 proof states. No Lightning, no network, no NPC.
 *
 * The signing keys and signatures are genuine (`@cashu/cashu-ts` mint-side
 * helpers), so a wallet that receives these signatures can unblind and verify
 * them exactly as with a production mint.
 */
import {
  createBlindSignature,
  createNewMintKeys,
  pointFromHex,
} from "@cashu/cashu-ts";

/** NUT error codes used by the scenarios. */
export const QUOTE_EXPIRED = 20007;
export const ALREADY_ISSUED = 20002;

export type FakeQuoteState = "UNPAID" | "PAID" | "ISSUED";

export interface FakeMintQuote {
  quote: string;
  request: string;
  amount: number;
  unit: string;
  state: FakeQuoteState;
  /** Epoch seconds, or null for a quote that never expires. */
  expiry: number | null;
  amountPaid: number;
  amountIssued: number;
  pubkey: null;
}

export interface FakeMintRequest {
  quote: string;
  outputs: Array<{ amount: number; id: string; B_: string }>;
}

interface StoredSignature {
  amount: number;
  id: string;
  C_: string;
}

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export class FakeMint {
  readonly keysetId: string;
  readonly keysByAmount: Record<string, string>;
  readonly requests: FakeMintRequest[] = [];
  /** Every output the mint has ever signed, keyed by B_. */
  readonly signed = new Map<string, StoredSignature>();

  /** When set, POST /v1/mint/bolt11 fails with this NUT error. */
  mintError: { code: number; detail: string } | null = null;
  /** When set, quote creation returns this expiry (epoch seconds). */
  quoteExpiry: number | null = 3_600;
  /**
   * Awaited before responding to a mint request, so a test can hold minting
   * open and interleave another recovery attempt.
   */
  gate: Promise<void> | null = null;
  /** Awaited before answering a quote-state check, to hold observe open. */
  observeGate: Promise<void> | null = null;
  /**
   * When true, POST /v1/restore answers with NUT-09's spec-legal positional
   * arrays, including `null` for outputs the mint never signed.
   *
   * This is a known interop gap, not a supported path: cashu-ts 3.7.1 (which
   * coco depends on) dereferences every entry of `signatures` while normalising
   * amounts, so a `null` makes the wallet throw instead of skipping it. The
   * switch exists so tests keep that behaviour visible; see
   * mint-quote-recovery.fake-mint.test.ts.
   */
  restoreIncludesNulls = false;

  private readonly quotes = new Map<string, FakeMintQuote>();
  private counter = 0;
  private server?: ReturnType<typeof Bun.serve>;

  constructor() {
    const pair = createNewMintKeys(20, new Uint8Array(32).fill(9));
    this.keysetId = pair.keysetId;
    this.keysByAmount = Object.fromEntries(
      Object.entries(pair.pubKeys).map(([amount, key]) => [
        amount,
        typeof key === "string" ? key : toHex(key),
      ]),
    );
    this.privKeys = Object.fromEntries(
      Object.entries(pair.privKeys) as Array<[string, Uint8Array]>,
    );
  }

  private readonly privKeys: Record<string, Uint8Array>;

  get url(): string {
    if (!this.server) throw new Error("fake mint not started");
    return `http://127.0.0.1:${this.server.port}`;
  }

  start(): void {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }

  /** Test control: the mint sees the invoice as paid but has issued nothing. */
  markPaid(quoteId: string): void {
    const quote = this.quotes.get(quoteId);
    if (!quote) throw new Error(`unknown fake quote ${quoteId}`);
    quote.state = "PAID";
    quote.amountPaid = quote.amount;
  }

  /**
   * Test control: mark the quote issued without going through the mint
   * endpoint, simulating a wallet that lost the signatures.
   */
  markIssued(quoteId: string): void {
    const quote = this.quotes.get(quoteId);
    if (!quote) throw new Error(`unknown fake quote ${quoteId}`);
    quote.state = "ISSUED";
    quote.amountPaid = quote.amount;
    quote.amountIssued = quote.amount;
  }

  /** Test control: sign outputs directly, as if another wallet had issued them. */
  signFor(quoteId: string, outputs: FakeMintRequest["outputs"]): void {
    for (const output of outputs) {
      this.signOutput(output);
    }
    this.markIssued(quoteId);
  }

  getQuote(quoteId: string): FakeMintQuote | undefined {
    return this.quotes.get(quoteId);
  }

  private quoteBody(quote: FakeMintQuote) {
    return {
      quote: quote.quote,
      request: quote.request,
      amount: quote.amount,
      unit: quote.unit,
      state: quote.state,
      expiry: quote.expiry,
      amount_paid: quote.amountPaid,
      amount_issued: quote.amountIssued,
      pubkey: quote.pubkey,
    };
  }

  private signOutput(output: {
    amount: number;
    id: string;
    B_: string;
  }): StoredSignature {
    const privKey = this.privKeys[String(output.amount)];
    if (!privKey) {
      throw new Error(`fake mint has no key for amount ${output.amount}`);
    }
    const signature = createBlindSignature(
      pointFromHex(output.B_),
      privKey,
      this.keysetId,
    );
    const stored: StoredSignature = {
      amount: output.amount,
      id: this.keysetId,
      C_: toHex(signature.C_.toBytes(false)),
    };
    this.signed.set(output.B_, stored);
    return stored;
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private error(code: number, detail: string, status = 400): Response {
    return this.json({ code, detail }, status);
  }

  private async handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const body = async () => {
      try {
        return (await request.json()) as Record<string, unknown>;
      } catch {
        return {};
      }
    };

    if (pathname === "/v1/info") {
      return this.json({
        name: "fake-mint",
        version: "0.0.1",
        nuts: {
          4: {
            methods: [
              {
                method: "bolt11",
                unit: "sat",
                min_amount: 1,
                max_amount: 1_000_000,
              },
            ],
          },
          5: {
            methods: [
              {
                method: "bolt11",
                unit: "sat",
                min_amount: 1,
                max_amount: 1_000_000,
              },
            ],
          },
          7: { supported: true },
          9: { supported: true },
        },
      });
    }

    if (pathname === "/v1/keys" || pathname.startsWith("/v1/keys/")) {
      return this.json({
        keysets: [
          { id: this.keysetId, unit: "sat", keys: this.keysByAmount },
        ],
      });
    }

    if (pathname === "/v1/keysets") {
      return this.json({
        keysets: [{ id: this.keysetId, unit: "sat", active: true }],
      });
    }

    if (pathname === "/v1/mint/quote/bolt11" && request.method === "POST") {
      const input = await body();
      const amount = Number(input.amount);
      const unit = typeof input.unit === "string" ? input.unit : "sat";
      const quote: FakeMintQuote = {
        quote: `fake-quote-${++this.counter}`,
        request: `lnbcfake${this.counter}`,
        amount,
        unit,
        state: "UNPAID",
        expiry:
          this.quoteExpiry === null
            ? null
            : Math.floor(Date.now() / 1000) + this.quoteExpiry,
        amountPaid: 0,
        amountIssued: 0,
        pubkey: null,
      };
      this.quotes.set(quote.quote, quote);
      return this.json(this.quoteBody(quote));
    }

    const quoteMatch = pathname.match(/^\/v1\/mint\/quote\/bolt11\/(.+)$/);
    if (quoteMatch?.[1] && request.method === "GET") {
      if (this.observeGate) await this.observeGate;
      const quote = this.quotes.get(decodeURIComponent(quoteMatch[1]));
      if (!quote) return this.error(50000, "Unknown quote");
      return this.json(this.quoteBody(quote));
    }

    if (pathname === "/v1/mint/bolt11" && request.method === "POST") {
      const input = await body();
      const quoteId = String(input.quote);
      const outputs = (input.outputs ?? []) as FakeMintRequest["outputs"];
      this.requests.push({ quote: quoteId, outputs });
      if (this.gate) await this.gate;
      if (this.mintError) {
        return this.error(this.mintError.code, this.mintError.detail);
      }
      const quote = this.quotes.get(quoteId);
      if (!quote) return this.error(50000, "Unknown quote");
      if (quote.state === "ISSUED" || quote.amountIssued > 0) {
        return this.error(ALREADY_ISSUED, "Quote already issued");
      }
      if (quote.state !== "PAID") {
        return this.error(20001, "Quote is not paid");
      }
      const total = outputs.reduce((sum, o) => sum + Number(o.amount), 0);
      if (total > quote.amountPaid - quote.amountIssued) {
        return this.error(10002, "Outputs exceed the paid amount");
      }
      const signatures = outputs.map((output) => ({
        amount: output.amount,
        id: this.keysetId,
        C_: this.signOutput(output).C_,
      }));
      quote.state = "ISSUED";
      quote.amountIssued += total;
      return this.json({ signatures });
    }

    if (pathname === "/v1/restore" && request.method === "POST") {
      const input = await body();
      const outputs = (input.outputs ?? []) as FakeMintRequest["outputs"];
      if (this.restoreIncludesNulls) {
        // Spec-legal NUT-09 shape, including nulls. Kept behind a switch
        // because it is currently unusable with coco's cashu-ts version.
        return this.json({
          outputs,
          signatures: outputs.map(
            (output) => this.signed.get(output.B_) ?? null,
          ),
        });
      }
      // Return only the signed outputs; coco matches them by B_ and treats the
      // rest as "nothing to restore".
      const signed = outputs.filter((output) => this.signed.has(output.B_));
      return this.json({
        outputs: signed,
        signatures: signed.map((output) => this.signed.get(output.B_)),
      });
    }

    if (pathname === "/v1/checkstate" && request.method === "POST") {
      const input = await body();
      const ys = (input.Ys ?? []) as string[];
      return this.json({
        states: ys.map((Y) => ({ Y, state: "UNSPENT", witness: null })),
      });
    }

    return this.error(404, `fake mint has no route for ${pathname}`, 404);
  }
}
