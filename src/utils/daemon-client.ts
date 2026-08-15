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

class DaemonConnectionError extends Error {
  constructor(cause: unknown) {
    super("Failed to connect to daemon", { cause });
    this.name = "DaemonConnectionError";
  }
}

export function getDaemonBaseUrl(config: RoutstrdConfig): string {
  if (config.daemonUrl) {
    return config.daemonUrl.replace(/\/$/, "");
  }
  return `http://${urlHost(config.host)}:${config.port}`;
}

export function getAuthBaseUrl(config: RoutstrdConfig): string {
  if (config.authUrl) {
    return config.authUrl.replace(/\/$/, "");
  }
  return getDaemonBaseUrl(config);
}

async function _callUrl(
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

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: bodyString,
    });
  } catch (error) {
    throw new DaemonConnectionError(error);
  }

  if (!response.ok) {
    const errorData = (await response.json()) as { error?: string };
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<CommandResponse>;
}

async function callLocalDaemon(
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: object },
  config: RoutstrdConfig,
): Promise<CommandResponse> {
  // Retry only connection failures; HTTP errors prove that a server answered.
  let connectionError: DaemonConnectionError | undefined;
  for (const baseUrl of localDaemonBaseUrls(config)) {
    try {
      return await _callUrl(baseUrl, path, options, config);
    } catch (error) {
      if (!(error instanceof DaemonConnectionError)) throw error;
      connectionError = error;
    }
  }
  throw connectionError ?? new Error("No daemon host candidates available");
}

export async function callDaemon(
  path: string,
  options: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: object } = {},
): Promise<CommandResponse> {
  const config = await loadConfig();
  if (config.daemonUrl) {
    return _callUrl(getDaemonBaseUrl(config), path, options, config);
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
  return _callUrl(getAuthBaseUrl(config), path, options, config);
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const config = await loadConfig();

    if (config.daemonUrl) {
      const baseUrl = config.daemonUrl.replace(/\/$/, "");
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
        return false;
      }
    }

    // A wildcard bind may be listening on either loopback family.
    for (const baseUrl of localDaemonBaseUrls(config)) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetch(`${baseUrl}/health`, {
          signal: controller.signal,
        });
        if (response.ok) return true;
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