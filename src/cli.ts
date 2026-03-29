import { startDaemon } from "./start-daemon";
import {
  program,
  handleDaemonCommand,
  callDaemon,
  ensureDaemonRunning,
  isDaemonRunning,
  loadConfig,
} from "./cli-shared";
import { existsSync, mkdirSync } from "fs";
import {
  CONFIG_DIR,
  DB_PATH,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  LOG_FILE,
  type RoutstrdConfig,
} from "./utils/config";
import { logger } from "./utils/logger";
import { setupIntegration } from "./integrations";
import { createSdkStore } from "@routstr/sdk";
import { createBunSqliteDriver } from "@routstr/sdk/storage";

type RoutstrModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
};

type UsageEntry = {
  id: string;
  timestamp: number;
  modelId: string;
  baseUrl: string;
  requestId: string;
  cost: number;
  satsCost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  client?: string;
};

const cliVersion = "0.1.1";

async function initDaemon(): Promise<void> {
  logger.log("Initializing routstrd...");

  if (!(await checkCocodInstalled())) {
    logger.log("cocod not found. Installing globally with bun...");

    const installProc = Bun.spawn(["bun", "install", "--global", "cocod"], {
      stdout: "inherit",
      stderr: "inherit",
    });

    const installCode = await installProc.exited;
    if (installCode !== 0 || !(await checkCocodInstalled())) {
      logger.error(
        "Failed to install cocod. Please run 'bun install --global cocod' manually.",
      );
      return;
    }

    logger.log("cocod installed successfully.");
  }

  // Create config directory
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    logger.log(`Created config directory: ${CONFIG_DIR}`);
  }

  // Create initial config
  if (!existsSync(CONFIG_FILE)) {
    const config: RoutstrdConfig = {
      ...DEFAULT_CONFIG,
      cocodPath: null,
    };
    await Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));
    logger.log(`Created config file: ${CONFIG_FILE}`);
  }

  console.log(`Database will be stored at: ${DB_PATH}`);
  console.log("\nInitializing cocod...");

  const initProc = Bun.spawn(["cocod", "init"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let initStdout = "";
  let initStderr = "";

  const stdoutDone = initProc.stdout
    ? initProc.stdout.pipeTo(
        new WritableStream<Uint8Array>({
          write(chunk) {
            const text = new TextDecoder().decode(chunk);
            initStdout += text;
            process.stdout.write(text);
          },
        }),
      )
    : Promise.resolve();

  const stderrDone = initProc.stderr
    ? initProc.stderr.pipeTo(
        new WritableStream<Uint8Array>({
          write(chunk) {
            const text = new TextDecoder().decode(chunk);
            initStderr += text;
            process.stderr.write(text);
          },
        }),
      )
    : Promise.resolve();

  const [initCode] = await Promise.all([
    initProc.exited,
    stdoutDone,
    stderrDone,
  ]);
  const combinedOutput = `${initStdout}\n${initStderr}`.toLowerCase();
  const alreadyInitialized = combinedOutput.includes("already initialized");

  if (initCode !== 0 && !alreadyInitialized) {
    logger.error(
      "Failed to initialize cocod. Please run 'cocod init' manually.",
    );
    return;
  }

  if (alreadyInitialized) {
    logger.log("cocod is already initialized.");
  } else {
    logger.log("cocod initialized successfully.");
  }

  const config = await loadConfig();
  await startDaemon({ port: String(config.port || 8008) });

  // Create SDK store for integrations
  const sqliteDriver = await createBunSqliteDriver(DB_PATH);
  const { store } = await createSdkStore({ driver: sqliteDriver });

  await setupIntegration(config, store);

  logger.log("\nInitialization complete!");
  logger.log(
    "\n use 'cocod receive cashu' or 'cocod receive bolt11 2100' to top up your local wallet!",
  );
}

async function checkCocodInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn({
      cmd: ["which", "cocod"],
      stdout: "pipe",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

program
  .name("routstrd")
  .description("Routstr daemon - Manage routstr processes")
  .version(cliVersion, "--version", "output the version number");

// Onboard - initialize the daemon
program
  .command("onboard")
  .description(
    "Initialize routstrd (creates config directory and initializes cocod)",
  )
  .action(async () => {
    await initDaemon();
  });

// Start - start the background daemon
program
  .command("start")
  .description("Start the background daemon")
  .option("--port <port>", "Port to listen on")
  .option("-p, --provider <provider>", "Default provider to use")
  .action(async (options: { port?: string; provider?: string }) => {
    if (!(await checkCocodInstalled())) {
      logger.error(
        "cocod is not installed. Run 'routstrd onboard' first to install cocod.",
      );
      process.exit(1);
    }
    const config = await loadConfig();
    await startDaemon({
      port: options.port || String(config.port || 8008),
      provider: options.provider,
    });
  });

// Status - check daemon status
program
  .command("status")
  .description("Check daemon and wallet status")
  .action(async () => {
    const running = await isDaemonRunning();
    if (!running) {
      console.log("Daemon is not running");
      process.exit(1);
    }

    const result = await callDaemon("/status");
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
  });

// Balance - get wallet and API key balances
program
  .command("balance")
  .description("Get wallet and API key balances")
  .action(async () => {
    await ensureDaemonRunning();

    const [walletResult, keysResult] = await Promise.all([
      callDaemon("/balance"),
      callDaemon("/keys/balance"),
    ]);

    console.log("Checking full system balance...\n");

    console.log("=== Wallet Balance ===");
    let totalWallet = 0;
    if (
      walletResult.output &&
      typeof walletResult.output === "object" &&
      "balances" in walletResult.output
    ) {
      const balances = (
        walletResult.output as { balances: Record<string, number> }
      ).balances;
      for (const [mintUrl, balance] of Object.entries(balances)) {
        console.log(`  ${mintUrl}: ${balance} sats`);
        totalWallet += balance;
      }
      console.log(`  Total: ${totalWallet} sats`);
    } else if (walletResult.error) {
      console.error("Wallet error:", walletResult.error);
    }

    console.log("\n=== API Keys ===");
    let totalApiKeys = 0;
    if (
      keysResult.output &&
      typeof keysResult.output === "object" &&
      "keys" in keysResult.output
    ) {
      const keys = (
        keysResult.output as {
          keys: Array<{ id: string; name: string; balance: number }>;
        }
      ).keys;
      const apiKeyEntries = keys.filter((k) => k.id.startsWith("apikey:"));
      for (const key of apiKeyEntries) {
        const name = key.name.replace("API Key: ", "");
        console.log(`  ${name}: ${key.balance} sats`);
        totalApiKeys += key.balance;
      }
      if (apiKeyEntries.length === 0) {
        console.log("  No API keys found");
      } else {
        console.log(`  Total: ${totalApiKeys} sats`);
      }
    } else if (keysResult.error) {
      console.error("Keys error:", keysResult.error);
    }

    console.log("\n=== Summary ===");
    console.log(
      `  Wallet: ${totalWallet} sats | API Keys: ${totalApiKeys} sats`,
    );
    console.log(`  Grand Total: ${totalWallet + totalApiKeys} sats`);
  });

// Ping
program
  .command("ping")
  .description("Test connection to the daemon")
  .action(async () => {
    await handleDaemonCommand("/ping");
  });

// Models - list routstr21 models
program
  .command("models")
  .description("List available routstr21 models")
  .option("-r, --refresh", "Force refresh routstr21 models from Nostr", false)
  .action(async (options: { refresh: boolean }) => {
    await ensureDaemonRunning();

    const result = await callDaemon(
      options.refresh ? "/models?refresh=true" : "/models",
    );
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    if (
      result.output &&
      typeof result.output === "object" &&
      "models" in result.output
    ) {
      const models = (result.output as { models: RoutstrModel[] }).models;
      if (models.length === 0) {
        console.log("No routstr21 models found");
      } else {
        console.log(`\nFound ${models.length} routstr21 models:`);
        models.forEach((model, i) => {
          const details = [
            model.name && model.name !== model.id ? model.name : null,
            model.context_length ? `${model.context_length} ctx` : null,
          ]
            .filter(Boolean)
            .join(" - ");
          console.log(`${i + 1}. ${model.id}${details ? ` (${details})` : ""}`);
        });
      }
    }
  });

program
  .command("usage")
  .description("Show recent usage logs and total sats cost")
  .option("-n, --limit <number>", "Number of recent usage entries", "10")
  .action(async (options: { limit: string }) => {
    await ensureDaemonRunning();

    const requested = Number.parseInt(options.limit, 10);
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, 1000)
        : 10;

    const result = await callDaemon(`/usage?limit=${limit}`);
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as
      | {
          entries?: UsageEntry[];
          totalEntries?: number;
          totalSatsCost?: number;
          recentSatsCost?: number;
          limit?: number;
        }
      | undefined;

    const entries = output?.entries || [];
    const totalEntries = output?.totalEntries || 0;
    const totalSatsCost = output?.totalSatsCost || 0;
    const recentSatsCost = output?.recentSatsCost || 0;

    console.log(`Usage entries: showing ${entries.length} of ${totalEntries}`);
    console.log(`Total sats cost (all time): ${totalSatsCost.toFixed(3)} sats`);
    console.log(`Sats cost (shown entries): ${recentSatsCost.toFixed(3)} sats`);

    if (entries.length === 0) {
      console.log("No usage entries yet.");
      return;
    }

    console.log("");
    entries.forEach((entry, index) => {
      const time = new Date(entry.timestamp).toISOString();
      const provider = entry.baseUrl || "unknown";
      const reqId = entry.requestId || "unknown";
      const client = entry.client ? ` | client: ${entry.client}` : "";
      console.log(
        `${index + 1}. ${time} | ${entry.modelId} | ${provider} | ${entry.satsCost.toFixed(3)} sats${client}`,
      );
      console.log(
        `   tokens p/c/t: ${entry.promptTokens}/${entry.completionTokens}/${entry.totalTokens} | request: ${reqId}`,
      );
    });
  });

// Providers - list and manage providers
const providersCmd = program
  .command("providers")
  .description("List and manage providers");

providersCmd
  .command("list")
  .description("List all providers with their enabled/disabled status")
  .action(async () => {
    await ensureDaemonRunning();

    const result = await callDaemon("/providers");
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as
      | {
          providers: Array<{
            index: number;
            baseUrl: string;
            disabled: boolean;
          }>;
          disabledCount: number;
          totalCount: number;
        }
      | undefined;

    if (!output?.providers) {
      console.log("No providers found.");
      return;
    }

    console.log(
      `Providers (${output.totalCount} total, ${output.disabledCount} disabled):\n`,
    );
    for (const provider of output.providers) {
      const status = provider.disabled ? "DISABLED" : "enabled ";
      console.log(`  [${provider.index}] ${status}  ${provider.baseUrl}`);
    }
  });

providersCmd
  .command("disable <indices...>")
  .description(
    "Disable providers by their indices (e.g., routstrd providers disable 0 2 5)",
  )
  .action(async (indices: string[]) => {
    await ensureDaemonRunning();

    const indexNums = indices
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
    if (indexNums.length === 0) {
      console.log("No valid indices provided.");
      process.exit(1);
    }

    const result = await callDaemon("/providers/disable", {
      method: "POST",
      body: { indices: indexNums },
    });

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as
      | { message: string; disabled: string[] }
      | undefined;
    if (output) {
      console.log(output.message);
      for (const url of output.disabled) {
        console.log(`  - ${url}`);
      }
    }
  });

providersCmd
  .command("enable <indices...>")
  .description(
    "Enable providers by their indices (e.g., routstrd providers enable 0 2 5)",
  )
  .action(async (indices: string[]) => {
    await ensureDaemonRunning();

    const indexNums = indices
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n));
    if (indexNums.length === 0) {
      console.log("No valid indices provided.");
      process.exit(1);
    }

    const result = await callDaemon("/providers/enable", {
      method: "POST",
      body: { indices: indexNums },
    });

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as
      | { message: string; enabled: string[] }
      | undefined;
    if (output) {
      console.log(output.message);
      for (const url of output.enabled) {
        console.log(`  - ${url}`);
      }
    }
  });

// Monitor - interactive TUI
program
  .command("monitor")
  .description("Open interactive TUI for usage monitoring (htop-like)")
  .action(async () => {
    const { runUsageTui } = await import("./tui/usage/index.ts");
    await runUsageTui();
  });

// Stop
program
  .command("stop")
  .description("Stop the background daemon")
  .action(async () => {
    await handleDaemonCommand("/stop", { method: "POST" });
  });

// Restart
program
  .command("restart")
  .description("Restart the background daemon")
  .option("--port <port>", "Port to listen on")
  .option("-p, --provider <provider>", "Default provider to use")
  .action(async (options: { port?: string; provider?: string }) => {
    const config = await loadConfig();
    const wasRunning = await isDaemonRunning();

    if (wasRunning) {
      console.log("Stopping daemon...");
      await callDaemon("/stop", { method: "POST" });

      // Wait for daemon to fully stop
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!(await isDaemonRunning())) {
          break;
        }
      }

      if (await isDaemonRunning()) {
        logger.error("Daemon failed to stop within 5 seconds");
        process.exit(1);
      }
      console.log("Daemon stopped.");
    } else {
      console.log("Daemon was not running.");
    }

    console.log("Starting daemon...");
    await startDaemon({
      port: options.port || String(config.port || 8008),
      provider: options.provider,
    });
    console.log("Daemon restarted.");
  });

// Mode
program
  .command("mode")
  .description("Set the client mode (xcashu or apikeys)")
  .action(async () => {
    const config = await loadConfig();
    const currentMode = config.mode || "apikeys";

    console.log("Select client mode:");
    console.log(
      "  1) apikeys    - Pseudonymous accounts are kept with the Routstr nodes for easy topup and refunds.",
    );
    console.log(
      "  2) xcashu     - Balances are never kept with the nodes, all balances are refunded in response.",
    );
    console.log(`\nCurrent mode: ${currentMode}`);

    const modes: Array<"apikeys" | "xcashu"> = ["apikeys", "xcashu"];

    const selectedIndex = await new Promise<number>((resolve) => {
      const rl = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question("\nEnter choice (1-3): ", (answer: string) => {
        rl.close();
        const num = parseInt(answer, 10);
        resolve(Number.isFinite(num) && num >= 1 && num <= 3 ? num - 1 : 0);
      });
    });

    const selectedMode = modes[selectedIndex];

    if (selectedMode === currentMode) {
      console.log(`Mode is already set to '${selectedMode}'. No changes made.`);
      return;
    }

    // Update config
    const updatedConfig: RoutstrdConfig = {
      ...config,
      mode: selectedMode,
    };
    await Bun.write(CONFIG_FILE, JSON.stringify(updatedConfig, null, 2));
    console.log(`Mode set to '${selectedMode}'. Restarting daemon...`);

    // Restart daemon
    const wasRunning = await isDaemonRunning();
    if (wasRunning) {
      console.log("Stopping daemon...");
      await callDaemon("/stop", { method: "POST" });

      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!(await isDaemonRunning())) {
          break;
        }
      }

      if (await isDaemonRunning()) {
        logger.error("Daemon failed to stop within 5 seconds");
        process.exit(1);
      }
      console.log("Daemon stopped.");
    }

    console.log("Starting daemon...");
    await startDaemon({
      port: String(config.port || 8008),
      provider: config.provider || undefined,
    });
    console.log(`Daemon restarted with mode '${selectedMode}'.`);
  });

// Logs
program
  .command("logs")
  .description("View daemon logs")
  .option("-f, --follow", "Follow log output", false)
  .option("-n, --lines <number>", "Number of lines to show", "50")
  .action(async (options: { follow: boolean; lines: string }) => {
    if (!existsSync(LOG_FILE)) {
      console.log("No log file found. Daemon may not have started yet.");
      process.exit(1);
    }

    const lines = parseInt(options.lines, 10);

    const readLastLines = async (): Promise<string[]> => {
      const content = await Bun.file(LOG_FILE).text();
      const allLines = content.split("\n").filter(Boolean);
      return allLines.slice(-lines);
    };

    const printLines = async (): Promise<void> => {
      const lastLines = await readLastLines();
      for (const line of lastLines) {
        console.log(line);
      }
    };

    if (options.follow) {
      const logFile = Bun.file(LOG_FILE);
      const initialContent = await logFile.text();
      let lastSize = initialContent.length;

      await printLines();

      const interval = setInterval(async () => {
        const content = await Bun.file(LOG_FILE).text();
        const currentSize = content.length;
        if (currentSize > lastSize) {
          const allLines = content.split("\n").filter(Boolean);
          const newLines = allLines.slice(
            Math.floor(lastSize === 0 ? 0 : -1),
            -1,
          );
          for (const line of newLines) {
            console.log(line);
          }
          lastSize = currentSize;
        }
      }, 1000);

      process.on("SIGINT", () => {
        clearInterval(interval);
        process.exit(0);
      });
    } else {
      await printLines();
    }
  });

export function cli(args: string[]) {
  program.parse(args);
}
