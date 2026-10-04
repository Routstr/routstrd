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
 * Upper bound for a single daemon request, including response-body
 * consumption. The daemon bounds its own NWC operations, so this only guards
 * against a wedged server; without it a hung request would block the CLI
 * forever.
 */
export const DAEMON_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Upper bound for value-moving wallet routes. A cashu melt/swap can
 * legitimately run longer than {@link DAEMON_REQUEST_TIMEOUT_MS} (the mint has
 * no request timeout in routstrd), so these get a more generous bound that
 * still prevents an indefinite CLI hang.
 */
export const DAEMON_LONG_REQUEST_TIMEOUT_MS = 600_000;

/** Routes that may legitimately outlive the default request timeout. */
const LONG_RUNNING_ROUTES = ["/wallet/send/", "/wallet/receive/"];

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
  if (bodyString) headers.set("Content-Type", "application/json");

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
      const errorData = (await response.json()) as { error?: string };
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }
    return (await response.json()) as CommandResponse;
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

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const config = await loadConfig();

    if (config.daemonUrl) {
      for (const baseUrl of baseUrlCandidates(config.daemonUrl)) {
        const url = `${baseUrl}/health`;
        let authorization: string | undefined;
        if (config.nsec) {
          const secretKey = parseSecretKey(config.nsec);
          authorization = await createNIP98Authorization(secretKey, url, "GET");
        }
        try {
          const response = await fetch(url, {
            headers: authorization ? { Authorization: authorization } : {},
          });
          return response.ok;
        } catch {
          // Try the next candidate host.
        }
      }
      return false;
    }

    // A wildcard bind may be listening on either loopback family.
    for (const baseUrl of localDaemonBaseUrls(config)) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetch(`${baseUrl}/health`, {
          signal: controller.signal,
        });
        return response.ok;
      } catch {
        // Try the next candidate host.
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return false;
  } catch {
    return false;
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

export function getNpubSuffix(config: RoutstrdConfig): string | null {
  const npub = getUserNpub(config);
  if (!npub) return null;
  return npub.slice(-7);
}

export async function startDaemonProcess(): Promise<void> {
  const config = await loadConfig();
  await startDaemon({
    port: String(config.port || 8008),
    host: config.host || undefined,
    provider: config.provider || undefined,
  });
}

export async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonRunning()) {
    return;
  }

  const config = await loadConfig();
  if (config.daemonUrl) {
    throw new Error(`Daemon is not reachable at ${config.daemonUrl}`);
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