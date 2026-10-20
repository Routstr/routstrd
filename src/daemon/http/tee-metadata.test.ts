import { describe, expect, it, mock } from "bun:test";
import { forwardTeeMetadata, type TeeMetadataDeps } from "./tee-metadata";

const provider = "https://provider.example/";
const deps = (): TeeMetadataDeps => ({
  provider: null,
  store: { getState: () => ({ baseUrlsList: [provider] }) },
  discoveryAdapter: { getDisabledProviders: () => [] },
  ensureProvidersBootstrapped: async () => {},
});
const url = (path = "/v1/tee/attestation") =>
  new URL(`http://localhost${path}?model=e2ee-test&nonce=${"a".repeat(64)}`);
const fetcher = (status = 200) =>
  mock(async (_url: URL, _options: RequestInit) =>
    Response.json({ verified: true }, { status }),
  );

describe("TEE metadata transport", () => {
  it("forwards only approved query fields to a pinned known provider", async () => {
    const fetch = fetcher();
    const u = url();
    u.searchParams.set("api_key", "do-not-forward");
    const response = await forwardTeeMetadata(u, provider, deps(), fetch);
    expect(response?.status).toBe(200);
    const [target, options] = fetch.mock.calls[0]!;
    expect(target.href).toBe(
      `https://provider.example/v1/tee/attestation?model=e2ee-test&nonce=${"a".repeat(64)}`,
    );
    expect(options.headers).toEqual({ accept: "application/json" });
    expect(options.redirect).toBe("error");
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });
  it("requires provider pin and rejects unknown and disabled providers before network I/O", async () => {
    const fetch = fetcher();
    const d = deps();
    expect((await forwardTeeMetadata(url(), undefined, d, fetch))?.status).toBe(
      400,
    );
    expect(
      (await forwardTeeMetadata(url(), "http://169.254.169.254", d, fetch))
        ?.status,
    ).toBe(403);
    d.discoveryAdapter.getDisabledProviders = () => [provider];
    expect((await forwardTeeMetadata(url(), provider, d, fetch))?.status).toBe(
      403,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("honors normalized manual enable overrides and avoids double v1 prefixes", async () => {
    const d = deps();
    const p = "https://provider.example/v1";
    d.store.getState = () => ({ baseUrlsList: [p] });
    d.discoveryAdapter.getDisabledProviders = () => [p + "/"];
    d.discoveryAdapter.getManuallyEnabledProviders = () => [p];
    const fetch = fetcher();
    expect((await forwardTeeMetadata(url(), p, d, fetch))?.status).toBe(200);
    expect(fetch.mock.calls[0]![0].href).not.toContain("/v1/v1/");
  });
  it("does not widen the daemon GET surface", async () => {
    const fetch = fetcher();
    expect(
      await forwardTeeMetadata(
        url("/v1/tee/attestation/evil"),
        provider,
        deps(),
        fetch,
      ),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed nonces and repeated model parameters", async () => {
    const fetch = fetcher();
    const u = url();
    u.searchParams.set("nonce", "short");
    expect((await forwardTeeMetadata(u, provider, deps(), fetch))?.status).toBe(
      400,
    );
    const duplicate = url();
    duplicate.searchParams.append("model", "other");
    expect(
      (await forwardTeeMetadata(duplicate, provider, deps(), fetch))?.status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("forwards signature IDs and preserves upstream errors", async () => {
    const u = url("/tee/signature/");
    u.searchParams.set("request_id", "chatcmpl-test");
    const fetch = fetcher(404);
    expect((await forwardTeeMetadata(u, provider, deps(), fetch))?.status).toBe(
      404,
    );
    const target = fetch.mock.calls[0]![0];
    expect(target.searchParams.get("request_id")).toBe("chatcmpl-test");
    expect(target.searchParams.has("nonce")).toBe(false);
  });
  it("fails closed on network or redirect errors", async () => {
    const fetch = mock(async () => {
      throw new Error("redirect");
    });
    expect(
      (await forwardTeeMetadata(url(), provider, deps(), fetch))?.status,
    ).toBe(502);
  });
  it("bounds evidence size", async () => {
    const fetch = async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1));
    expect(
      (await forwardTeeMetadata(url(), provider, deps(), fetch))?.status,
    ).toBe(502);
  });
});
