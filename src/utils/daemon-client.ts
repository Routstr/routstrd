import { existsSync } from "fs";
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  LOGS_DIR,
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

export function getDaemonBaseUrl(config: RoutstrdConfig): string {
  return (
    config.daemonUrl?.replace(/\/$/, "") || `http://localhost:${config.port}`
  );
}

export async function callDaemon(
  path: string,
  options: { method?: "GET" | "POST" | "DELETE"; body?: object } = {},
): Promise<CommandResponse> {
  const { method = "GET", body } = options;
  const config = await loadConfig();
  const baseUrl = getDaemonBaseUrl(config);
  const url = `${baseUrl}${path}`;

  const bodyString = body ? JSON.stringify(body) : undefined;
  const bodyBytes = bodyString
    ? new TextEncoder().encode(bodyString)
    : undefined;

  let authorization: string | undefined;
  if (config.daemonUrl && config.nsec) {
    const secretKey = parseSecretKey(config.nsec);
    authorization = await createNIP98Authorization(
      secretKey,
      url,
      method as HttpMethod,
      bodyBytes,
    );
  }

  const response = await fetch(url, {
    method,
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(bodyString ? { "Content-Type": "application/json" } : {}),
    },
    body: bodyString,
  });

  if (!response.ok) {
    const errorData = (await response.json()) as { error?: string };
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<CommandResponse>;
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const config = await loadConfig();
    const baseUrl = getDaemonBaseUrl(config);
    const url = `${baseUrl}/health`;

    let authorization: string | undefined;
    if (config.daemonUrl && config.nsec) {
      const secretKey = parseSecretKey(config.nsec);
      authorization = await createNIP98Authorization(secretKey, url, "GET");
    }

    const response = await fetch(url, {
      headers: authorization ? { Authorization: authorization } : {},
    });
    return response.ok;
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
  // Ensure logs directory exists (logger handles date-based files)
  if (!existsSync(LOGS_DIR)) {
    await Bun.$`mkdir -p ${LOGS_DIR}`;
  }

  const proc = Bun.spawn(
    ["bun", "run", `${import.meta.dir}/../daemon/index.ts`],
    {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "ignore",
      detached: true,
    },
  );

  proc.unref();

  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await isDaemonRunning()) {
      return;
    }
  }

  throw new Error("Daemon failed to start within 5 seconds");
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