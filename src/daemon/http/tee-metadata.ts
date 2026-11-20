const PATHS = new Set(["/tee/attestation", "/tee/signature"]);

export type TeeMetadataDeps = {
  provider: string | null;
  store: { getState(): { baseUrlsList?: string[] } };
  discoveryAdapter: {
    getDisabledProviders(): string[];
    getManuallyDisabledProviders?(): string[];
    getManuallyEnabledProviders?(): string[];
  };
  ensureProvidersBootstrapped(): Promise<void>;
};

function normalize(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Invalid provider URL");
  }
  return url.href.replace(/\/$/, "");
}

function error(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

/** Public evidence only. Never send the daemon's auth key or wallet tokens. */
export async function forwardTeeMetadata(
  url: URL,
  providerHeader: string | undefined,
  deps: TeeMetadataDeps,
  fetcher: (url: URL, options: RequestInit) => Promise<Response> = fetch,
): Promise<Response | null> {
  const path = url.pathname.replace(/^\/v1\//, "/").replace(/\/$/, "");
  if (!PATHS.has(path)) return null;
  const model = url.searchParams.get("model");
  if (!model || url.searchParams.getAll("model").length !== 1)
    return error("One model is required");
  const param = path.endsWith("attestation") ? "nonce" : "request_id";
  const value = url.searchParams.get(param);
  if (
    !value ||
    url.searchParams.getAll(param).length !== 1 ||
    (param === "nonce" && !/^[a-fA-F0-9]{64}$/.test(value))
  ) {
    return error(
      param === "nonce"
        ? "nonce must be 32 bytes of hex"
        : "request_id is required",
    );
  }
  const selected =
    url.searchParams.get("provider") || providerHeader || deps.provider;
  if (!selected)
    return error(
      "Pin a provider for TEE metadata and use the same provider for inference",
    );
  try {
    await deps.ensureProvidersBootstrapped();
  } catch {
    return error("Provider discovery unavailable", 503);
  }
  let provider: string;
  try {
    provider = normalize(selected);
  } catch {
    return error("Invalid provider URL");
  }
  const normalized = (values: string[]) =>
    new Set(
      values.flatMap((v) => {
        try {
          return [normalize(v)];
        } catch {
          return [];
        }
      }),
    );
  const known = normalized(deps.store.getState().baseUrlsList || []);
  const manual = normalized(
    deps.discoveryAdapter.getManuallyEnabledProviders?.() || [],
  );
  const disabled = normalized([
    ...(deps.discoveryAdapter.getDisabledProviders() || []),
    ...(deps.discoveryAdapter.getManuallyDisabledProviders?.() || []),
  ]);
  if (
    !known.has(provider) ||
    (disabled.has(provider) && !manual.has(provider))
  ) {
    return error("TEE provider must be a known enabled provider", 403);
  }
  const target = new URL(provider.replace(/\/v1$/, "") + "/v1" + path);
  target.searchParams.set("model", model);
  target.searchParams.set(param, value);
  try {
    const response = await fetcher(target, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            return error("TEE evidence exceeds 4 MiB", 502);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    return new Response(
      response.status === 204 || response.status === 304
        ? null
        : Buffer.concat(chunks),
      {
        status: response.status,
        headers: {
          "content-type":
            response.headers.get("content-type") || "application/json",
          "cache-control": "no-store",
        },
      },
    );
  } catch {
    return error("TEE metadata provider request failed", 502);
  }
}
