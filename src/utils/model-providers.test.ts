import { describe, expect, it } from "bun:test";
import {
  formatModelProviders,
  PROVIDER_COLUMN_MAX,
  truncateMiddle,
  type ModelProviderInfo,
  type ModelWithProviders,
} from "./model-providers";

function provider(partial: Partial<ModelProviderInfo> = {}): ModelProviderInfo {
  return {
    baseUrl: partial.baseUrl ?? "https://routstr.otrta.me/",
    disabled: partial.disabled ?? false,
    pricing: partial.pricing ?? {
      prompt: 0.0002,
      completion: 0.0008,
      request: 0.001,
      max_cost: 446,
      cache: {
        read: 0.00002,
        write: 0,
        readAdvertised: true,
        writeAdvertised: false,
      },
    },
  };
}

function model(partial: Partial<ModelWithProviders> = {}): ModelWithProviders {
  return {
    id: partial.id ?? "deepseek-v4.1-flash-1017",
    name: partial.name,
    description: partial.description,
    context_length: partial.context_length,
    providers: partial.providers ?? [provider()],
    hiddenProviders: partial.hiddenProviders ?? 0,
  };
}

describe("truncateMiddle", () => {
  it("leaves a value that fits untouched", () => {
    const url = "https://routstr.otrta.me/";
    expect(truncateMiddle(url, url.length)).toBe(url);
  });

  it("keeps both ends of an over-long URL, ellipsis in the middle", () => {
    const url = "https://fiscal-cancel-immune-finishing.trycloudflare.com/";
    const out = truncateMiddle(url, 44);
    expect(out.length).toBe(44);
    expect(out).toContain("…");
    expect(out.startsWith("https://fiscal")).toBe(true);
    expect(out.endsWith("cloudflare.com/")).toBe(true);
  });

  it("elides at the default width", () => {
    const url = `https://${"a".repeat(80)}.example.com/`;
    expect(truncateMiddle(url).length).toBe(PROVIDER_COLUMN_MAX);
  });
});

describe("formatModelProviders", () => {
  it("prints the model header and one table row per provider", () => {
    const out = formatModelProviders(
      model({
        name: "DeepSeek V4.1 Flash 1017",
        description: "deepseek via ccm",
        context_length: 1048576,
        providers: [
          provider({ baseUrl: "https://routstr.eduvietkieu.com/" }),
          provider({ baseUrl: "https://routstr.nostrnative.com/", disabled: true }),
        ],
      }),
    );

    expect(out).toContain(
      "deepseek-v4.1-flash-1017 (DeepSeek V4.1 Flash 1017)",
    );
    expect(out).toContain("  deepseek via ccm");
    expect(out).toContain("  Context: 1,048,576 tokens");
    expect(out).toContain("2 providers, cheapest warm request first");
    expect(out).toContain("Rates in sats per million tokens");
    // Per-token rates render per million tokens.
    expect(out).toContain("200.00");
    expect(out).toContain("800.00");
    expect(out).toContain("20.00");
    expect(out).toContain("https://routstr.eduvietkieu.com/");
    expect(out).toContain("https://routstr.nostrnative.com/");
    expect(out).toContain("✓ enabled");
    expect(out).toContain("✗ disabled");
  });

  it("omits request and max-cost pricing", () => {
    const out = formatModelProviders(model());
    expect(out).not.toContain("Request");
    expect(out).not.toContain("Max cost");
    expect(out).not.toContain("446");
  });

  it("marks enabled and disabled providers", () => {
    const out = formatModelProviders(
      model({
        providers: [
          provider({ baseUrl: "https://on.example/" }),
          provider({ baseUrl: "https://off.example/", disabled: true }),
        ],
      }),
    );
    const on = out.split("\n").find((line) => line.includes("https://on.example/"));
    const off = out.split("\n").find((line) => line.includes("https://off.example/"));
    expect(on?.trimEnd().endsWith("✓")).toBe(true);
    expect(off?.trimEnd().endsWith("✗")).toBe(true);
  });

  it("shows a cache rate only when the node advertised it", () => {
    const out = formatModelProviders(
      model({
        providers: [
          provider({
            baseUrl: "https://advertised.example/",
            pricing: {
              prompt: 0.0002,
              completion: 0.0008,
              request: 0.001,
              max_cost: 0,
              cache: {
                read: 0.00001,
                write: 0.000005,
                readAdvertised: true,
                writeAdvertised: true,
              },
            },
          }),
          provider({
            baseUrl: "https://filled.example/",
            pricing: {
              prompt: 0.0003,
              completion: 0.0009,
              request: 0.001,
              max_cost: 0,
              // The SDK filled both cache rates from the prompt rate.
              cache: {
                read: 0.0003,
                write: 0.0003,
                readAdvertised: false,
                writeAdvertised: false,
              },
            },
          }),
        ],
      }),
    );

    const advertised = out
      .split("\n")
      .find((line) => line.includes("https://advertised.example/"));
    const filled = out
      .split("\n")
      .find((line) => line.includes("https://filled.example/"));
    expect(advertised).toContain("10.00");
    expect(advertised).toContain("5.00");
    // Both cache cells render as "-": the prompt rate is never shown as a
    // cache price.
    expect(filled?.match(/-/g)?.length).toBe(2);
    expect(out).toContain("billed at the prompt rate");
  });

  it("keeps a long provider URL from widening the table", () => {
    const out = formatModelProviders(
      model({
        providers: [
          provider({ baseUrl: "https://routstr.otrta.me/" }),
          provider({
            baseUrl: "https://fiscal-cancel-immune-finishing.trycloudflare.com/",
          }),
        ],
      }),
    );
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThan(120);
    }
    expect(out).toContain("…");
  });

  it("handles a payload with no providers", () => {
    expect(formatModelProviders(model({ providers: [] }))).toContain(
      "No node serves this model.",
    );
  });

  it("reads an empty provider list with a hidden count as 'only disabled nodes'", () => {
    // The CLI turns a null payload into "Model not found"; a model served
    // only by disabled nodes arrives with an empty list instead, and must not
    // be reported as unserved.
    const out = formatModelProviders(
      model({ providers: [], hiddenProviders: 3 }),
    );

    expect(out).toContain(
      "No enabled node serves this model (3 disabled; pass --all to show them).",
    );
    expect(out).not.toContain("Provider  Prompt");
  });

  it("says how many nodes the default view hides", () => {
    const out = formatModelProviders(
      model({
        providers: [provider({ baseUrl: "https://on.example/" })],
        hiddenProviders: 9,
      }),
    );

    expect(out).toContain("1 provider, cheapest warm request first");
    expect(out).toContain(
      "9 disabled nodes hidden — pass --all to show them",
    );
    // The hidden nodes are not rows: only the enabled one is priced.
    expect(out).not.toContain("https://off.example/");
    expect(out.split("\n").filter((line) => line.includes("https://")).length).toBe(1);
  });

  it("counts hidden nodes in the singular", () => {
    const out = formatModelProviders(
      model({ providers: [provider()], hiddenProviders: 1 }),
    );

    expect(out).toContain("1 disabled node hidden — pass --all to show it");
  });

  it("does not mention disabled nodes when none were hidden", () => {
    const out = formatModelProviders(model());

    expect(out).not.toContain("pass --all");
    // Nothing disabled is on show, so the legend does not advertise a state
    // it never renders.
    expect(out).toContain("  ✓ enabled\n");
    expect(out).not.toContain("✗ disabled");
  });

  it("tolerates a daemon that predates cache pricing", () => {
    const out = formatModelProviders(
      model({
        providers: [
          {
            baseUrl: "https://old-daemon.example/",
            disabled: false,
            pricing: {
              prompt: 0.0002,
              completion: 0.0008,
              request: 0.001,
              max_cost: 1,
            },
          },
        ],
      }),
    );
    expect(out).toContain("https://old-daemon.example/");
    expect(out).toContain("200.00");
  });
});
