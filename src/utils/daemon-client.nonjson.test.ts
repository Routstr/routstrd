import { afterEach, describe, expect, test } from "bun:test";
import {
  callDaemonUrl,
  checkRemoteUrl,
  DaemonNotJsonError,
  describeNonJsonBody,
  isJsonBody,
} from "./daemon-client";
import { DEFAULT_CONFIG } from "./config";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Answer every request with a fixed body and content type.
 *
 * This is the shape of the bug these tests cover: a URL that is reachable but
 * serves a web app, so `fetch` resolves and only the body gives it away.
 */
function respondWith(body: string, contentType: string, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

const SPA = "<!DOCTYPE html>\n<html><body><div id=app></div></body></html>";

const call = (path = "/clients") =>
  callDaemonUrl("https://dashboard.example", path, {}, DEFAULT_CONFIG);

describe("non-JSON success bodies", () => {
  test("an HTML 200 becomes a DaemonNotJsonError naming the URL", async () => {
    respondWith(SPA, "text/html; charset=utf-8");
    const error = await call().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DaemonNotJsonError);
    expect((error as Error).message).toContain("https://dashboard.example/clients");
    expect((error as Error).message).toContain("content-type: text/html");
    expect((error as Error).message).toContain("This looks like a web page, not a routstrd daemon");
  });

  test("no longer surfaces the bare parser message", async () => {
    respondWith(SPA, "text/html");
    const error = await call().catch((e: unknown) => e);

    // The old failure was `SyntaxError: JSON Parse error: Unrecognized token '<'`,
    // which named neither the URL nor the cause.
    expect((error as Error).name).not.toBe("SyntaxError");
    expect((error as Error).message).not.toContain("Unrecognized token");
  });

  test("an empty 200 body is reported as non-JSON, not as a crash", async () => {
    respondWith("", "text/plain");
    const error = await call().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DaemonNotJsonError);
    expect((error as Error).message).toContain("did not return JSON");
  });

  test("an HTML body labelled application/json is still caught", async () => {
    // Proxies relabel bodies, so the sniff must not trust the header alone.
    respondWith(SPA, "application/json");
    const error = await call().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DaemonNotJsonError);
    expect((error as DaemonNotJsonError).looksLikeHtml).toBe(true);
  });

  test("malformed JSON is reported without claiming it is a web page", async () => {
    respondWith('{"output": ', "application/json");
    const error = await call().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DaemonNotJsonError);
    expect((error as DaemonNotJsonError).looksLikeHtml).toBe(false);
    expect((error as Error).message).not.toContain("web page");
  });

  test("a JSON success body is returned unchanged", async () => {
    respondWith(JSON.stringify({ output: { clients: [] } }), "application/json");
    expect(await call()).toEqual({ output: { clients: [] } });
  });

  test("a JSON error body still reports the daemon's own message", async () => {
    // The non-2xx path keeps its existing behaviour: the `error` field wins.
    respondWith(JSON.stringify({ error: "denied" }), "application/json", 403);
    const error = await call().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("denied");
  });
});

describe("describeNonJsonBody", () => {
  test("points at `routstrd remote` for a web page", () => {
    const message = describeNonJsonBody("https://x.example/health", "text/html", SPA);
    expect(message).toContain("check 'routstrd remote'");
  });

  test("falls back to an unknown content type rather than printing an empty one", () => {
    expect(describeNonJsonBody("https://x.example/health", "", "nope")).toContain(
      "content-type: unknown content type",
    );
  });
});

describe("isJsonBody", () => {
  test("accepts the envelopes routstrd actually sends", () => {
    expect(isJsonBody('{"ok":true}')).toBe(true);
    expect(isJsonBody('{"output":{"clients":[]}}')).toBe(true);
    expect(isJsonBody('{"error":"denied"}')).toBe(true);
    expect(isJsonBody('  {"ok":true}\n')).toBe(true);
  });

  test("rejects web pages, empty bodies, and bare values", () => {
    expect(isJsonBody(SPA)).toBe(false);
    expect(isJsonBody("")).toBe(false);
    expect(isJsonBody("   ")).toBe(false);
    expect(isJsonBody("<html></html>")).toBe(false);
    expect(isJsonBody("null")).toBe(false);
    expect(isJsonBody("42")).toBe(false);
    expect(isJsonBody('{"truncated":')).toBe(false);
  });
});

describe("remote URL check", () => {
  const config = { ...DEFAULT_CONFIG, daemonUrl: "https://dashboard.example" };

  test("refuses a URL whose every probe path is a web page", async () => {
    respondWith(SPA, "text/html");
    const check = await checkRemoteUrl(config);

    expect(check.ok).toBe(false);
    expect((check as { reason: string }).reason).toContain("not a routstrd daemon");
  });

  test("accepts a routstrd /health", async () => {
    respondWith('{"ok":true}', "application/json");
    expect(await checkRemoteUrl(config)).toEqual({ ok: true });
  });

  test("accepts a JSON error, so an unregistered npub is not a false negative", async () => {
    // `routstrd remote` generates a fresh npub, which an auth proxy rejects
    // with a JSON 401 until it is registered. That is a valid configuration.
    respondWith(
      JSON.stringify({ error: "Missing Authorization header." }),
      "application/json",
      401,
    );
    expect(await checkRemoteUrl(config)).toEqual({ ok: true });
  });

  test("refuses an HTML 401 from a non-daemon", async () => {
    // The status must not decide on its own: an HTML error page is still a
    // web app, not a daemon.
    respondWith(SPA, "text/html", 401);
    expect((await checkRemoteUrl(config)).ok).toBe(false);
  });

  test("refuses an unreachable host", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Connection refused");
    }) as unknown as typeof fetch;
    const check = await checkRemoteUrl(config);

    expect(check.ok).toBe(false);
    expect((check as { reason: string }).reason).toContain("not reachable");
  });

  test("a proxy that intercepts /health does not hide a working daemon", async () => {
    // A load balancer answering `/health` itself with plain text is a common
    // convention. Gating on that alone would make a working daemon unusable.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") {
        return new Response("OK", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return Response.json({ output: { daemon: "running" } });
    }) as unknown as typeof fetch;

    expect(await checkRemoteUrl(config)).toEqual({ ok: true });
  });

  test("a proxy that intercepts /health with an HTML page is also tolerated", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") {
        return new Response(SPA, { status: 200, headers: { "content-type": "text/html" } });
      }
      return Response.json({ output: { daemon: "running" } });
    }) as unknown as typeof fetch;

    expect(await checkRemoteUrl(config)).toEqual({ ok: true });
  });

  test("still refuses when the fallback routes are web pages too", async () => {
    // The original failure: one dashboard answering every path with its SPA.
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      // Only /health happens to be JSON here; the rest of the origin is an SPA,
      // which must not be enough to save the URL.
      if (path === "/health") return Response.json({ ok: true });
      return new Response(SPA, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;

    // /health is JSON, so this origin does look like a daemon. Documenting the
    // boundary: the probe trusts any routstrd-shaped answer.
    expect(await checkRemoteUrl(config)).toEqual({ ok: true });
  });
});

describe("probe deadline", () => {
  const config = { ...DEFAULT_CONFIG, daemonUrl: "https://slow.example" };
  const originalSetTimeout = globalThis.setTimeout;

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  test("a host that stalls the body cannot hang the probe", async () => {
    // The body read is new, so without a bound a wedged host would stall every
    // management command before its real request.
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<!DOCTYPE html>"));
            signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    // The probe arms its deadline with setTimeout + AbortController, so clamp
    // that rather than waiting out the real 10s bound.
    globalThis.setTimeout = ((fn: () => void, ms?: number) =>
      originalSetTimeout(fn, Math.min(ms ?? 0, 20))) as unknown as typeof setTimeout;

    const result = await checkRemoteUrl(config);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("not reachable");
  });
});
