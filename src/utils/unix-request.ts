/**
 * HTTP over a Unix domain socket, on both Bun and Deno.
 *
 * Bun supports this as a non-standard `fetch(url, { unix })` option; Deno does
 * not. `node:http`'s `socketPath` works identically on both, so it is used for
 * the legacy-cocod IPC instead.
 */

import { request as httpRequest } from "node:http";

export interface UnixRequestInit {
  /** Path to the Unix domain socket to connect to. */
  unix: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** An error carrying a `code`, so callers can match on ECONNREFUSED/ENOENT. */
function withCode(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** `fetch`-shaped request over a Unix socket. Only the path of `url` is used. */
export function unixFetch(url: string | URL, init: UnixRequestInit): Promise<Response> {
  const { pathname, search } = new URL(String(url));

  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: init.unix,
        path: `${pathname}${search}`,
        method: init.method ?? "GET",
        ...(init.headers ? { headers: init.headers } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", (error) => reject(withCode(error)));
        res.on("end", () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(key, value);
            else if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
          }
          const status = res.statusCode ?? 500;
          // 204/304 must not carry a body.
          const body = status === 204 || status === 304 ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, statusText: res.statusMessage ?? "", headers }));
        });
      },
    );

    req.on("error", (error) => reject(withCode(error)));

    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy();
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      init.signal.addEventListener("abort", () => {
        req.destroy();
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    }

    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
