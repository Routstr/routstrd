import { program } from "commander";
import { existsSync } from "fs";
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  LOG_FILE,
  type RoutstrdConfig,
} from "./utils/config";

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

async function callDaemon(
  path: string,
  options: { method?: "GET" | "POST"; body?: object } = {},
): Promise<CommandResponse> {
  const { method = "GET", body } = options;
  const config = await loadConfig();

  const response = await fetch(`http://localhost:${config.port}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
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
    const response = await fetch(`http://localhost:${config.port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export async function startDaemonProcess(): Promise<void> {
  const logFile = Bun.file(LOG_FILE);

  const proc = Bun.spawn([
    "bun", "run", `${import.meta.dir}/daemon/index.ts`
  ], {
    stdout: logFile,
    stderr: logFile,
    stdin: "ignore",
    detached: true,
  });
  
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
    if (message?.includes("fetch failed") || message?.includes("Connection refused")) {
      console.error("Daemon is not running and failed to auto-start");
      process.exit(1);
    }
    console.error(message);
    process.exit(1);
  }
}

export { program, callDaemon };

program
  .command("refund")
  .description("Refund pending tokens and API keys to a specified mint")
  .option("-m, --mint-url <mintUrl>", "Mint URL to refund to (defaults to first mint in wallet)")
  .option("-y, --yes", "Skip confirmation prompt", false)
  .action(async (options: { mintUrl?: string; yes: boolean }) => {
    const config = await loadConfig();

    let mintUrl = options.mintUrl;
    if (!mintUrl) {
      const balanceResponse = await fetch(`http://localhost:${config.port}/balance`);
      const balanceResult = (await balanceResponse.json()) as {
        output?: { balances?: Record<string, number> };
        error?: string;
      };
      if (balanceResult.error) {
        console.log(balanceResult.error);
        process.exit(1);
      }
      const balances = balanceResult.output?.balances;
      if (!balances || Object.keys(balances).length === 0) {
        console.log("No mint URLs found in wallet balance");
        process.exit(1);
      }
      mintUrl = Object.keys(balances)[0];
      console.log(`Using mint URL: ${mintUrl}`);
    }

    try {
      const response = await fetch(`http://localhost:${config.port}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mintUrl }),
      });

      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const result = (await response.json()) as {
        output?: {
          message: string;
          pendingTokens: number;
          apiKeys: number;
          results: Array<{ baseUrl: string; success: boolean }>;
        };
        error?: string;
      };

      if (result.error) {
        console.log(result.error);
        process.exit(1);
      }

      if (result.output) {
        console.log(result.output.message);
        console.log(`\nPending tokens: ${result.output.pendingTokens}`);
        console.log(`API keys: ${result.output.apiKeys}`);
        console.log("\nResults:");
        for (const r of result.output.results) {
          console.log(`  - ${r.baseUrl}: ${r.success ? "success" : "failed"}`);
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      if (message?.includes("fetch failed") || message?.includes("Connection refused")) {
        console.error("Daemon is not running");
        process.exit(1);
      }
      console.error(message);
      process.exit(1);
    }
  });
