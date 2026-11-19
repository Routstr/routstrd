import { existsSync } from "fs";
import { startDaemon } from "../start-daemon";
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  type RoutstrdConfig,
} from "./config";
import {
  createNIP98Authorization,
  parseSecretKey,
  npubFromSecretKey,
  type HttpMethod,
} from "./nip98";

export interface CommandResponse {
  output?: unknown;
  error?: string;
}

export async function loadConfig(): Promise<RoutstrdConfig> {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = await Bun.file(CONFIG_FILE).text();
      return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
    }
  } catch (error) {
    console.error("Failed to load config:", error);
  }
  return DEFAULT_CONFIG;
}

/** Format a bind address for use as a URL host. */
export function urlHost(host?: string): string {
  return urlHosts(host)[0] ?? "127.0.0.1";
}

/** Return connectable URL hosts for a bind address, in preference order. */
export function urlHosts(host?: string): string[] {
  if (!host || host === "0.0.0.0") return ["127.0.0.1", "[::1]"];
  if (host === "::") return ["[::1]", "127.0.0.1"];
  if (host.startsWith("[") && host.endsWith("]")) return [host];
  if (host.includes(":")) return [`[${host.replace(/%/g, "%25")}]`];
  return [host];
}

function localDaemonBaseUrls(config: RoutstrdConfig): string[] {
  return urlHosts(config.host).map(
    (host) => `http://${host}:${config.port}`,
  );
}

/**
 * Normalize a user-supplied daemon/auth URL.
 *
 * `new URL("localhost:8008")` does not throw -- it parses `localhost:` as the
 * scheme -- so a scheme-less value silently becomes an unusable base URL.
 * Add `http://` when no scheme is present and strip trailing slashes.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
}

/**
 * Candidate base URLs for a configured remote endpoint.
 *
 * When the host is `localhost`, prefer the other loopback family as well:
 * some environments (notably rootless podman) accept a connection on one
 * family and immediately reset it, so a single `localhost` URL can fail even
 * though the server is reachable on `127.0.0.1` or `[::1]`.
 */
export function baseUrlCandidates(baseUrl: string): string[] {
  const normalized = normalizeBaseUrl(baseUrl);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return [normalized];
  }
  if (url.hostname !== "localhost") return [normalized];

  const candidates: string[] = [];
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const candidate = new URL(normalized);
    candidate.hostname = host;
    candidates.push(candidate.toString().replace(/\/+$/, ""));
  }
  return [...new Set(candidates)];
}

class DaemonConnectionError extends Error {
  constructor(cause: unknown) {
    super("Failed to connect to daemon", { cause });
    this.name = "DaemonConnectionError";
  }
}

/**
 * A reached daemon answered with a non-2xx status.
 *
 * The HTTP status is carried separately so callers can branch on it (e.g. "this
 * build has no such route yet") instead of matching the human-readable message,
 * which mirrors the body's `error` field and is free to change.
 */
export class DaemonHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DaemonHttpError";
  }
}

/**
 * How much of a response body is kept when explaining a non-JSON answer.
 *
 * Only the opening tag matters for the diagnosis, but keeping a few KB makes a
 * `DaemonNotJsonError` useful when logged or inspected in a debugger.
 */
const BODY_SNIFF_LENGTH = 4096;

/**
 * Whether a body opens like an HTML document.
 *
 * The content type is only a hint — proxies relabel bodies — so the markup is
 * checked as well. Used for the wording of the diagnosis and for
 * {@link DaemonNotJsonError.looksLikeHtml}, so the two cannot disagree.
 */
function looksLikeHtml(contentType: string, body: string): boolean {
  if (contentType.toLowerCase().includes("html")) return true;
  const head = body.slice(0, BODY_SNIFF_LENGTH).trimStart().slice(0, 64).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/**
 * A 2xx answer whose body is not the JSON envelope every routstrd route returns.
 *
 * This is the signature of a URL that is reachable but is not a routstrd
 * daemon: a reverse proxy's dashboard, an SPA that answers every path with
 * `index.html`, a captive portal. Without this check the body reaches
 * `response.json()` and the CLI dies with the parser's own message
 * ("JSON Parse error: Unrecognized token '<'"), which names neither the URL nor
 * the cause. The message is a complete, actionable sentence because that is
 * what the CLI prints.
 */
export class DaemonNotJsonError extends Error {
  constructor(
    readonly url: string,
    readonly contentType: string,
    /** The body, already truncated to {@link BODY_SNIFF_LENGTH}. */
    readonly body: string,
  ) {
    super(describeNonJsonBody(url, contentType, body));
    this.name = "DaemonNotJsonError";
  }

  /** True when the body is a web page rather than merely malformed JSON. */
  get looksLikeHtml(): boolean {
    return looksLikeHtml(this.contentType, this.body);
  }
}

/**
 * Word a non-JSON response as a diagnosis of the URL, not of the parser.
 *
 * Kept as a free function so the message can be asserted without constructing
 * the error, and so the request path and the health probe share one wording.
 */
export function describeNonJsonBody(
  url: string,
  contentType: string,
  body: string,
): string {
  const type = contentType.split(";")[0]?.trim() || "unknown content type";
  if (looksLikeHtml(contentType, body)) {
    return (
      `${url} did not return JSON (content-type: ${type}). ` +
      "This looks like a web page, not a routstrd daemon — check 'routstrd remote'."
    );
  }
  return (
    `${url} did not return JSON (content-type: ${type}). ` +
    "Check that it points at a routstrd daemon — see 'routstrd remote'."
  );
}

/**
 * Parse a 2xx response body as the routstrd JSON envelope.
 *
 * Throws {@link DaemonNotJsonError} instead of the parser's `SyntaxError`, so a
 * misconfigured URL is reported as such. An empty body is likewise not JSON: it
 * means something other than routstrd answered the request.
 */
async function parseJsonBody(response: Response, url: string): Promise<CommandResponse> {
  // Read as text first: `response.json()` would throw a SyntaxError with no
  // URL in it, and the body is needed to tell an HTML page from malformed JSON.
  const text = await response.text();
  try {
    return JSON.parse(text) as CommandResponse;
  } catch {
    throw new DaemonNotJsonError(
      url,
      response.headers.get("content-type") ?? "",
      text.slice(0, BODY_SNIFF_LENGTH),
    );
  }
}

/**
 * Whether a body parses as a JSON object.
 *
 * routstrd's own answers are objects (`{"ok":true}`, `{"output":...}`,
 * `{"error":...}`); anything else — an HTML page, an empty body, plain text —
 * means something other than routstrd answered.
 */
export function isJsonBody(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

/**
 * Upper bound for a single daemon request, including response-body
 * consumption. The daemon bounds its own NWC operations, so this only guards
 * against a wedged server; without it a hung request would block the CLI
 * forever.
 */
export const DAEMON_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Upper bound for the `/health` probe.
 *
 * The body is read now (to tell a daemon from a web page), which the probe used
 * to skip entirely, so both the headers and the body need a bound — otherwise a
 * host that sends headers and then stalls the body would hang every management
 * command.
 */
export const DAEMON_HEALTH_TIMEOUT_MS = 10_000;

/**
 * Bound for a loopback `/health` probe.
 *
 * Shorter than the remote bound because this runs against a daemon on this
 * machine: either it is listening or it is not, so there is nothing to wait for.
 */
export const LOCAL_DAEMON_HEALTH_TIMEOUT_MS = 2_000;

/** Upper bound for value-moving wallet routes. A cashu melt/swap can
 * legitimately run longer than {@link DAEMON_REQUEST_TIMEOUT_MS} (the mint has
 * no request timeout in routstrd), so these get a more generous bound that
 * still prevents an indefinite CLI hang.
 */
export const DAEMON_LONG_REQUEST_TIMEOUT_MS = 600_000;

/** Routes that may legitimately outlive the default request timeout. */
const LONG_RUNNING_ROUTES = ["/wallet/send/", "/wallet/receive/", "/wallet/sweep-offline", "/wallet/cleanup"];

function requestTimeoutMs(path: string): number {
  const pathname = path.split("?")[0] ?? path;
  return LONG_RUNNING_ROUTES.some((route) => pathname.startsWith(route))
    ? DAEMON_LONG_REQUEST_TIMEOUT_MS
    : DAEMON_REQUEST_TIMEOUT_MS;
}

export function getDaemonBaseUrl(config: RoutstrdConfig): string {
  if (config.daemonUrl) {
    return normalizeBaseUrl(config.daemonUrl);
  }
  return `http://${urlHost(config.host)}:${config.port}`;
}

export function getAuthBaseUrl(config: RoutstrdConfig): string {
  if (config.authUrl) {
    return normalizeBaseUrl(config.authUrl);
  }
  return getDaemonBaseUrl(config);
}

export async function callDaemonUrl(
  baseUrl: string,
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: object },
  config: RoutstrdConfig,
): Promise<CommandResponse> {
  const { method = "GET", body } = options;
  const url = `${baseUrl}${path}`;

  const bodyString = body ? JSON.stringify(body) : undefined;
  const bodyBytes = bodyString
    ? new TextEncoder().encode(bodyString)
    : undefined;

  let authorization: string | undefined;
  if ((config.daemonUrl || config.authUrl) && config.nsec) {
    const secretKey = parseSecretKey(config.nsec);
    authorization = await createNIP98Authorization(
      secretKey,
      url,
      method as HttpMethod,
      bodyBytes,
    );
  }

  const headers = new Headers();
  if (authorization) headers.set("Authorization", authorization);
  if (bodyString || method === "POST") headers.set("Content-Type", "application/json");

  const timeoutMs = requestTimeoutMs(path);
  const timeoutError = () =>
    new Error(
      `Daemon request timed out after ${timeoutMs / 1000}s; ` +
        "any payment outcome is unknown — check before retrying",
    );
  // The signal stays armed while the body is read, so a daemon that sends
  // headers and then stalls the body cannot hang the CLI either. Aborting
  // here never cancels the daemon's operation — see timeoutError's warning.
  const signal = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: bodyString,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw timeoutError();
    // Only connection failures qualify for alternate-host retries.
    throw new DaemonConnectionError(error);
  }

  try {
    if (!response.ok) {
      // A non-JSON error body (an HTML page from a proxy, an empty 405) must not
      // surface as a JSON parse failure; fall back to the status text.
      const errorData = (await response
        .json()
        .catch(() => ({}))) as { error?: string };
      throw new DaemonHttpError(
        response.status,
        errorData.error || `HTTP ${response.status}`,
      );
    }
    // A 2xx body is JSON or the URL is not a routstrd daemon; parseJsonBody
    // turns the parser's SyntaxError into a diagnosis naming the URL.
    return await parseJsonBody(response, url);
  } catch (error) {
    if (signal.aborted) throw timeoutError();
    throw error;
  }
}

/** Resolve loopback addresses with safe reads, never by replaying a write. */
async function callDaemonCandidates(
  candidates: string[],
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: object },
  config: RoutstrdConfig,
): Promise<CommandResponse> {
  const isRead = (options.method ?? "GET") === "GET";
  let connectionError: DaemonConnectionError | undefined;
  for (const baseUrl of candidates) {
    if (!isRead && candidates.length > 1) {
      try {
        // Select an address before dispatching a potentially money-moving
        // request. An HTTP error is authoritative, not a reason to fall back.
        await callDaemonUrl(baseUrl, "/health", { method: "GET" }, config);
      } catch (error) {
        if (!(error instanceof DaemonConnectionError)) throw error;
        connectionError = error;
        continue;
      }
    }
    try {
      return await callDaemonUrl(baseUrl, path, options, config);
    } catch (error) {
      if (!(error instanceof DaemonConnectionError)) throw error;
      if (!isRead) {
        // fetch can reject after the server has committed the operation.
        throw new Error(
          "Connection lost; operation outcome is unknown — check its status before retrying",
          { cause: error },
        );
      }
      connectionError = error;
    }
  }
  throw connectionError ?? new Error("No daemon host candidates available");
}

async function callLocalDaemon(
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: object },
  config: RoutstrdConfig,
): Promise<CommandResponse> {
  return callDaemonCandidates(localDaemonBaseUrls(config), path, options, config);
}

async function callRemoteDaemon(
  baseUrl: string,
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: object },
  config: RoutstrdConfig,
): Promise<CommandResponse> {
  return callDaemonCandidates(baseUrlCandidates(baseUrl), path, options, config);
}

export async function callDaemon(
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: object } = {},
): Promise<CommandResponse> {
  const config = await loadConfig();
  if (config.daemonUrl) {
    return callRemoteDaemon(getDaemonBaseUrl(config), path, options, config);
  }
  return callLocalDaemon(path, options, config);
}

/** Like callDaemon but sends requests to the auth proxy URL instead.
 *  Falls back to the daemon URL if no authUrl is configured. */
export async function callAuth(
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: object } = {},
): Promise<CommandResponse> {
  const config = await loadConfig();
  if (!config.authUrl && !config.daemonUrl) {
    return callLocalDaemon(path, options, config);
  }
  return callRemoteDaemon(getAuthBaseUrl(config), path, options, config);
}

/**
 * Outcome of the daemon reachability probe.
 *
 * `json-error` and `not-json` are deliberately distinct. A non-2xx status with
 * a JSON body is a routstrd-shaped endpoint rejecting this caller — typically a
 * fresh, unregistered npub behind an auth proxy — and is a configuration worth
 * keeping. A body that is not JSON at all is a web page, which is not.
 */
export type HealthProbe =
  | { kind: "ok"; url: string }
  | { kind: "json-error"; url: string; status: number }
  | { kind: "not-json"; url: string; status: number; contentType: string; body: string }
  | { kind: "unreachable" };

/**
 * Paths probed to decide whether an origin is a routstrd daemon.
 *
 * `/health` is tried first because it is the cheapest and needs no auth, but it
 * is not authoritative on its own: an ingress or load balancer commonly
 * intercepts `/health` and answers it itself ("OK" as `text/plain`, a 200 HTML
 * page, ...) while proxying everything else to the daemon. Gating only on
 * `/health` would turn that proxy convention into a total outage for a daemon
 * that is in fact fully working, so a non-JSON `/health` falls through to a real
 * API route before the origin is declared not-a-daemon.
 *
 * Both fallbacks answer with a routstrd JSON envelope whether or not the caller
 * is authenticated — `/version` is unauthenticated, and `/status` answers a JSON
 * 401/403 rather than HTML when auth is required — so any of them distinguishes
 * "a routstrd-shaped API" from "a web page".
 */
const PROBE_PATHS = ["/health", "/version", "/status"] as const;

/**
 * Probe an origin for a routstrd daemon.
 *
 * A 2xx alone is not proof: a reverse proxy's dashboard answers every path with
 * its SPA, and accepting it makes `ensureDaemonRunning` hand the following
 * command to a web page. The body therefore has to parse as JSON — but from any
 * of {@link PROBE_PATHS}, not just `/health`, so an intercepted health check is
 * not mistaken for a non-daemon.
 *
 * Candidate hosts are tried in order, but an HTTP answer — even an error — is
 * authoritative and stops the walk: only a connection failure means the next
 * loopback family is worth trying.
 */
async function probeHealth(config: RoutstrdConfig): Promise<HealthProbe> {
  const remote = config.daemonUrl;
  const candidates = remote
    ? baseUrlCandidates(remote)
    : localDaemonBaseUrls(config);

  for (const baseUrl of candidates) {
    let unreachable = true;
    // The first path that answers anything at all decides the origin; a later
    // path only runs when the previous one was not JSON, i.e. when the origin
    // may still be a proxy that intercepts that particular path. The first
    // non-JSON answer is the one reported, because it is the most
    // representative (`/health`) and the reason the origin was rejected.
    let firstNonJson: HealthProbe | undefined;

    for (const path of PROBE_PATHS) {
      const url = `${baseUrl}${path}`;
      let authorization: string | undefined;
      if (remote && config.nsec) {
        try {
          authorization = await createNIP98Authorization(
            parseSecretKey(config.nsec),
            url,
            "GET",
          );
        } catch {
          // An unusable nsec must not turn a reachable daemon into "not
          // running"; these paths are unauthenticated unless a proxy in front
          // demands NIP-98.
          authorization = undefined;
        }
      }

      // Every probe is bounded, local and remote. A remote daemon gets the
      // longer bound because it may be genuinely slow; loopback only has to
      // prove something is listening, so it keeps its original short deadline.
      const controller = new AbortController();
      const timeoutMs = remote
        ? DAEMON_HEALTH_TIMEOUT_MS
        : LOCAL_DAEMON_HEALTH_TIMEOUT_MS;
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          headers: authorization ? { Authorization: authorization } : {},
          signal: controller.signal,
        });
        unreachable = false;

        // Read once, for both the status check and the JSON check below.
        const body = await response.text();
        const contentType = response.headers.get("content-type") ?? "";

        if (isJsonBody(body)) {
          return response.ok
            ? { kind: "ok", url }
            : { kind: "json-error", url, status: response.status };
        }

        firstNonJson ??= {
          kind: "not-json",
          url,
          status: response.status,
          contentType,
          body: body.slice(0, BODY_SNIFF_LENGTH),
        };
      } catch {
        // Connection failure or timeout: this origin is not answering at all.
        // Report the first path's failure rather than trying the rest — a host
        // that does not answer `/health` will not answer `/version` either.
        break;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    if (firstNonJson) return firstNonJson;
    if (unreachable) continue; // try the next candidate host
  }

  return { kind: "unreachable" };
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    return (await probeHealth(await loadConfig())).kind === "ok";
  } catch {
    return false;
  }
}

/**
 * Explain why the configured URL is not a usable daemon.
 *
 * Returned instead of a bare "not reachable" so a URL that points at a
 * dashboard, an SPA, or another web app is named as such — the failure mode
 * that otherwise only shows up later as a JSON parse error from an unrelated
 * command.
 */
export function describeHealthFailure(
  probe: Exclude<HealthProbe, { kind: "ok" }>,
  config: RoutstrdConfig,
): string {
  const target = config.daemonUrl ? normalizeBaseUrl(config.daemonUrl) : getDaemonBaseUrl(config);
  switch (probe.kind) {
    case "not-json":
      return (
        `Daemon is not reachable at ${target}. ` +
        describeNonJsonBody(probe.url, probe.contentType, probe.body)
      );
    case "json-error":
      return (
        `Daemon at ${target} rejected the health probe (HTTP ${probe.status} from ${probe.url}). ` +
        "It answered JSON, so it is probably a routstrd node or its auth proxy."
      );
    case "unreachable":
      return `Daemon is not reachable at ${target}.`;
  }
}

export function getUserNpub(config: RoutstrdConfig): string | null {
  if (!config.nsec) return null;
  try {
    const secretKey = parseSecretKey(config.nsec);
    return npubFromSecretKey(secretKey);
  } catch {
    return null;
  }
}

export async function startDaemonProcess(): Promise<void> {
  const config = await loadConfig();
  await startDaemon({
    port: String(config.port || 8008),
    host: config.host || undefined,
    provider: config.provider || undefined,
  });
}

export type RemoteUrlCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether a probe result describes something routstrd-shaped.
 *
 * Shared by {@link checkRemoteUrl} and {@link ensureDaemonRunning} so the two
 * cannot disagree about which URL is usable: `remote` would otherwise save a URL
 * that the very next command rejects.
 *
 * A JSON error counts. It is a routstrd node (or its auth proxy) rejecting this
 * particular caller — commonly a fresh, still unregistered npub, which resolves
 * itself once the npub is registered — and the real request reports that far
 * better than a reachability check can.
 */
function isUsableEndpoint(
  probe: HealthProbe,
): probe is Extract<HealthProbe, { kind: "ok" | "json-error" }> {
  return probe.kind === "ok" || probe.kind === "json-error";
}

/**
 * Decide whether a remote daemon URL is worth saving.
 *
 * Only a URL that answers like a web page, or not at all, blocks the write; see
 * {@link isUsableEndpoint} for why a JSON error is allowed through.
 */
export async function checkRemoteUrl(
  config: RoutstrdConfig,
): Promise<RemoteUrlCheck> {
  const probe = await probeHealth(config);
  if (isUsableEndpoint(probe)) return { ok: true };
  return { ok: false, reason: describeHealthFailure(probe, config) };
}

export async function ensureDaemonRunning(): Promise<void> {
  const config = await loadConfig();
  if (config.daemonUrl) {
    const probe = await probeHealth(config);
    if (isUsableEndpoint(probe)) return;
    // Local mode auto-starts a daemon, but a remote URL cannot be started from
    // here, so report why the configured one is unusable instead.
    throw new Error(describeHealthFailure(probe, config));
  }

  if (await isDaemonRunning()) {
    return;
  }

  console.log("Starting daemon...");
  await startDaemonProcess();
}

export async function handleDaemonCommand(
  path: string,
  options: { method?: "GET" | "POST"; body?: object } = {},
): Promise<CommandResponse> {
  try {
    await ensureDaemonRunning();
    const result = await callDaemon(path, options);

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    if (result.output !== undefined) {
      if (typeof result.output === "string") {
        console.log(result.output);
      } else {
        try {
          const formatted = JSON.stringify(result.output, null, 2);
          console.log(formatted ?? String(result.output));
        } catch {
          console.log(String(result.output));
        }
      }
    }

    return result;
  } catch (error) {
    const message = (error as Error).message;
    if (
      message?.includes("fetch failed") ||
      message?.includes("Connection refused")
    ) {
      console.error("Daemon is not running and failed to auto-start");
      process.exit(1);
    }
    console.error(message);
    process.exit(1);
  }
}