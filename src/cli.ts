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
import { execSync } from "child_process";
import {
  CONFIG_DIR,
  DB_PATH,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  LOGS_DIR,
  type RoutstrdConfig,
} from "./utils/config";
import { logger } from "./utils/logger";
import {
  setupIntegration,
  CLIENT_CONFIGS,
  CLIENT_INTEGRATIONS,
} from "./integrations";
import { createSdkStore } from "@routstr/sdk";
import { createBunSqliteDriver } from "@routstr/sdk/storage";
import * as QRCode from "qrcode";
import {
  isCocodInstalled,
  resolveCocodExecutable,
} from "./daemon/wallet/cocod-client";

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

function parsePositiveIntOrExit(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`Invalid ${fieldName}: ${value}`);
    process.exit(1);
  }
  return parsed;
}

function isPositiveIntegerString(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

async function printLightningInvoice(invoice: string): Promise<void> {
  const paymentUri = `lightning:${invoice}`;
  const qr = await QRCode.toString(paymentUri, {
    type: "terminal",
    small: true,
  });

  console.log(`${qr}\nInvoice:\n${invoice}`);
}

async function installCocodOrExit(): Promise<void> {
  logger.log("cocod not found. Installing globally with bun...");

  const installProc = Bun.spawn(["bun", "install", "--global", "@routstr/cocod"], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const installCode = await installProc.exited;
  if (installCode !== 0 || !(await isCocodInstalled())) {
    logger.error(
      "Failed to install cocod. Please run 'bun install --global @routstr/cocod' manually.",
    );
    throw new Error("cocod installation failed");
  }

  logger.log("cocod installed successfully.");
}

async function initDaemon(): Promise<void> {
  logger.log("Initializing routstrd...");

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

  const config = await loadConfig();

  if (!(await isCocodInstalled(config.cocodPath))) {
    if (config.cocodPath) {
      logger.error(
        `Configured cocod executable was not found: ${config.cocodPath}`,
      );
      return;
    }

    await installCocodOrExit();
  }

  const cocodExecutable = resolveCocodExecutable(config.cocodPath);

  console.log(`Database will be stored at: ${DB_PATH}`);
  console.log("\nInitializing cocod...");

  const initProc = Bun.spawn([cocodExecutable, "init"], {
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

  await startDaemon({ port: String(config.port || 8008) });

  // Create SDK store for integrations
  const sqliteDriver = await createBunSqliteDriver(DB_PATH);
  const { store } = await createSdkStore({ driver: sqliteDriver });

  await setupIntegration(config, store);

  logger.log("\nInitialization complete!");
  logger.log(
    "\n use 'routstrd receive <cashu-token>' or 'routstrd receive 2100' to top up your local wallet using Lightning!",
  );
  logger.log(
    "\n full wallet commands still work too, e.g. 'routstrd wallet receive cashu <token>' and 'routstrd wallet receive bolt11 2100'.",
  );
  logger.log(
    "\nTo ensure routstrd persists across system restarts, run: 'routstrd service install'",
  );
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
    const config = await loadConfig();
    if (!(await isCocodInstalled(config.cocodPath))) {
      const installHint = config.cocodPath
        ? `Configured cocod executable was not found: ${config.cocodPath}`
        : "cocod is not installed. Run 'routstrd onboard' first to install cocod.";
      logger.error(installHint);
      process.exit(1);
    }
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
  .option("-m, --model <id>", "Show providers for a specific model")
  .action(async (options: { refresh: boolean; model?: string }) => {
    await ensureDaemonRunning();

    if (options.model) {
      // Show providers for specific model
      const result = await callDaemon(`/models/${encodeURIComponent(options.model)}/providers`);
      if (result.error) {
        console.log(result.error);
        process.exit(1);
      }

      const modelData = result.output as {
        id: string;
        name?: string;
        description?: string;
        context_length?: number;
        providers: Array<{
          baseUrl: string;
          pricing: {
            prompt: number;
            completion: number;
            request: number;
            max_cost: number;
          };
        }>;
      } | undefined;

      if (!modelData) {
        console.log("Model not found");
        process.exit(1);
      }

      console.log(`\n${modelData.name || modelData.id}`);
      if (modelData.description) {
        console.log(`  ${modelData.description}`);
      }
      if (modelData.context_length) {
        console.log(`  Context: ${modelData.context_length.toLocaleString()} tokens`);
      }
      console.log(`\n  Providers (${modelData.providers.length}):`);
      for (const provider of modelData.providers) {
        console.log(`\n    ${provider.baseUrl}`);
        console.log(`      Prompt:     ${(provider.pricing.prompt * 1000000).toFixed(2)} sats/M tokens`);
        console.log(`      Completion: ${(provider.pricing.completion * 1000000).toFixed(2)} sats/M tokens`);
        console.log(`      Request:    ${provider.pricing.request.toFixed(2)} sats`);
        console.log(`      Max cost:   ${provider.pricing.max_cost.toFixed(2)} sats`);
      }
      console.log("");
      return;
    }

    // List all models with interactive selection
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
        console.log("(Use 'routstrd models -m <model_id>' to see providers and pricing)\n");
        models.forEach((model, i) => {
          const details = [
            model.name && model.name !== model.id ? model.name : null,
            model.context_length ? `${model.context_length} ctx` : null,
          ]
            .filter(Boolean)
            .join(" - ");
          console.log(`  ${String(i + 1).padStart(2)}. ${model.id}${details ? ` (${details})` : ""}`);
        });
        console.log("");
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

    // The daemon returns { output: UsageEntry[] } where output is the array directly
    const entries = (result.output as UsageEntry[] | undefined) || [];

    // Calculate totals from entries
    const totalEntries = entries.length;
    const totalSatsCost = entries.reduce(
      (sum, e) => sum + (e.satsCost || 0),
      0,
    );
    const recentSatsCost = totalSatsCost; // For now, recent = total since we don't have time window

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

// Clients - list and manage clients
const clientsCmd = program
  .command("clients")
  .description("List and manage clients");

clientsCmd
  .command("list")
  .description("List all clients")
  .action(async () => {
    await ensureDaemonRunning();

    const result = await callDaemon("/clients");
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as
      | {
          clients: Array<{
            id: string;
            name: string;
            apiKey: string;
            createdAt: number;
            lastUsed?: number | null;
          }>;
          totalCount: number;
        }
      | undefined;

    if (!output?.clients || output.clients.length === 0) {
      console.log("No clients found.");
      return;
    }

    console.log(`Clients (${output.totalCount} total):\n`);
    for (const client of output.clients) {
      const createdAt = new Date(client.createdAt).toISOString();
      const lastUsed = client.lastUsed
        ? new Date(client.lastUsed).toISOString()
        : "never";
      console.log(`  ${client.id}`);
      console.log(`    Name:     ${client.name}`);
      console.log(`    API Key:  ${client.apiKey}`);
      console.log(`    Created:  ${createdAt}`);
      console.log("");
    }
  });

clientsCmd
  .command("add")
  .description("Add a new client or set up client integrations")
  .option("-n, --name <name>", "Client name")
  .option("--opencode", "Set up OpenCode integration")
  .option("--openclaw", "Set up OpenClaw integration")
  .option("--pi-agent", "Set up Pi Agent integration")
  .option("--claude-code", "Set up Claude Code integration")
  .action(async (options: {
    name?: string;
    opencode?: boolean;
    openclaw?: boolean;
    piAgent?: boolean;
    claudeCode?: boolean;
  }) => {
    await ensureDaemonRunning();
    const config = await loadConfig();

    const integrationKeys: string[] = [];
    if (options.opencode) integrationKeys.push("opencode");
    if (options.openclaw) integrationKeys.push("openclaw");
    if (options.piAgent) integrationKeys.push("pi-agent");
    if (options.claudeCode) integrationKeys.push("claude-code");

    if (integrationKeys.length > 0) {
      const sqliteDriver = await createBunSqliteDriver(DB_PATH);
      const { store } = await createSdkStore({ driver: sqliteDriver });

      for (const key of integrationKeys) {
        const integrationFn = CLIENT_INTEGRATIONS[key];
        const integrationConfig = CLIENT_CONFIGS[key];
        if (!integrationFn || !integrationConfig) continue;

        try {
          await integrationFn(config, store, integrationConfig);
        } catch (error) {
          logger.error(
            `Failed to set up ${integrationConfig.name} integration:`,
            error,
          );
          continue;
        }

        const state = store.getState();
        const client = (state.clientIds || []).find(
          (c: { clientId: string }) => c.clientId === key,
        );
        if (client) {
          console.log(`\n  ${integrationConfig.name}:`);
          console.log(`    Client ID: ${client.clientId}`);
          console.log(`    API Key:   ${client.apiKey}`);
        }
      }

      console.log(
        `\n  Access Routstr at: http://localhost:${config.port || 8008}/v1`,
      );
      return;
    }

    if (!options.name) {
      console.error(
        "error: required option '-n, --name <name>' not specified",
      );
      process.exit(1);
    }

    const result = await callDaemon("/clients/add", {
      method: "POST",
      body: { name: options.name },
    });

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    const output = result.output as
      | {
          message: string;
          client: {
            id: string;
            name: string;
            apiKey: string;
            createdAt: number;
          };
        }
      | undefined;

    if (output) {
      console.log(output.message);
      console.log(`\n  ID:     ${output.client.id}`);
      console.log(`  Name:   ${output.client.name}`);
      console.log(`  API Key: ${output.client.apiKey}`);
      console.log(
        `\n  Access Routstr at: http://localhost:${config.port || 8008}/v1`,
      );
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

program
  .command("top")
  .description("Open interactive TUI for usage monitoring (alias for monitor)")
  .action(async () => {
    const { runUsageTui } = await import("./tui/usage/index.ts");
    await runUsageTui();
  });

program
  .command("send <target>")
  .description(
    "Shortcut: numbers send Cashu, non-numbers pay a Lightning invoice",
  )
  .option("--mint-url <url>", "Mint URL to use")
  .action(async (target: string, options: { mintUrl?: string }) => {
    if (isPositiveIntegerString(target)) {
      await handleDaemonCommand("/wallet/send/cashu", {
        method: "POST",
        body: {
          amount: parsePositiveIntOrExit(target, "amount"),
          mintUrl: options.mintUrl,
        },
      });
      return;
    }

    await handleDaemonCommand("/wallet/send/bolt11", {
      method: "POST",
      body: {
        invoice: target,
        mintUrl: options.mintUrl,
      },
    });
  });

program
  .command("receive <value>")
  .description(
    "Shortcut: numbers create a Lightning invoice, non-numbers receive a Cashu token",
  )
  .option("--mint-url <url>", "Mint URL to use for bolt11 receive")
  .action(async (value: string, options: { mintUrl?: string }) => {
    if (isPositiveIntegerString(value)) {
      try {
        await ensureDaemonRunning();

        const result = await callDaemon("/wallet/receive/bolt11", {
          method: "POST",
          body: {
            amount: parsePositiveIntOrExit(value, "amount"),
            mintUrl: options.mintUrl,
          },
        });

        const output = result.output as
          | { invoice?: string; amount?: number; mintUrl?: string }
          | undefined;

        if (typeof output?.invoice === "string" && output.invoice) {
          await printLightningInvoice(output.invoice);
          return;
        }

        if (result.output !== undefined) {
          console.log(JSON.stringify(result.output, null, 2));
        }
      } catch (error) {
        console.error((error as Error).message);
        process.exit(1);
      }
      return;
    }

    await handleDaemonCommand("/wallet/receive/cashu", {
      method: "POST",
      body: { token: value },
    });
  });

const walletCmd = program.command("wallet").description("Wallet operations");

walletCmd
  .command("status")
  .description("Check wallet status")
  .action(async () => {
    await handleDaemonCommand("/wallet/status");
  });

walletCmd
  .command("unlock <passphrase>")
  .description("Unlock the wallet")
  .action(async (passphrase: string) => {
    await handleDaemonCommand("/wallet/unlock", {
      method: "POST",
      body: { passphrase },
    });
  });

walletCmd
  .command("balance")
  .description("Get wallet balance")
  .action(async () => {
    await handleDaemonCommand("/wallet/balance");
  });

const walletReceiveCmd = walletCmd
  .command("receive")
  .description("Wallet receive operations");

walletReceiveCmd
  .command("cashu <token>")
  .description("Receive a Cashu token")
  .action(async (token: string) => {
    await handleDaemonCommand("/wallet/receive/cashu", {
      method: "POST",
      body: { token },
    });
  });

walletReceiveCmd
  .command("bolt11 <amount>")
  .description("Create a Lightning invoice")
  .option("--mint-url <url>", "Mint URL to use")
  .action(async (amount: string, options: { mintUrl?: string }) => {
    try {
      await ensureDaemonRunning();

      const result = await callDaemon("/wallet/receive/bolt11", {
        method: "POST",
        body: {
          amount: parsePositiveIntOrExit(amount, "amount"),
          mintUrl: options.mintUrl,
        },
      });

      const output = result.output as
        | { invoice?: string; amount?: number; mintUrl?: string }
        | undefined;

      if (typeof output?.invoice === "string" && output.invoice) {
        await printLightningInvoice(output.invoice);
        return;
      }

      if (result.output !== undefined) {
        console.log(JSON.stringify(result.output, null, 2));
      }
    } catch (error) {
      console.error((error as Error).message);
      process.exit(1);
    }
  });

const walletSendCmd = walletCmd
  .command("send")
  .description("Wallet send operations");

walletSendCmd
  .command("cashu <amount>")
  .description("Create a Cashu token to send")
  .option("--mint-url <url>", "Mint URL to use")
  .action(async (amount: string, options: { mintUrl?: string }) => {
    await handleDaemonCommand("/wallet/send/cashu", {
      method: "POST",
      body: {
        amount: parsePositiveIntOrExit(amount, "amount"),
        mintUrl: options.mintUrl,
      },
    });
  });

walletSendCmd
  .command("bolt11 <invoice>")
  .description("Pay a Lightning invoice")
  .option("--mint-url <url>", "Mint URL to use")
  .action(async (invoice: string, options: { mintUrl?: string }) => {
    await handleDaemonCommand("/wallet/send/bolt11", {
      method: "POST",
      body: {
        invoice,
        mintUrl: options.mintUrl,
      },
    });
  });

const walletMintsCmd = walletCmd
  .command("mints")
  .description("Wallet mint operations");

walletMintsCmd
  .command("list")
  .description("List configured wallet mints")
  .action(async () => {
    await handleDaemonCommand("/wallet/mints");
  });

walletMintsCmd
  .command("add <url>")
  .description("Add a wallet mint")
  .action(async (url: string) => {
    await handleDaemonCommand("/wallet/mints", {
      method: "POST",
      body: { url },
    });
  });

walletMintsCmd
  .command("info <url>")
  .description("Get wallet mint info")
  .action(async (url: string) => {
    await handleDaemonCommand("/wallet/mints/info", {
      method: "POST",
      body: { url },
    });
  });

// Stop
program
  .command("stop")
  .description("Stop the background daemon")
  .action(async () => {
    await handleDaemonCommand("/stop", { method: "POST" });
  });

// Service - PM2 management
const serviceCmd = program
  .command("service")
  .description("Manage routstrd as a system service using PM2");

serviceCmd
  .command("install")
  .description("Install and start routstrd using PM2 for persistence")
  .action(async () => {
    // 1. Check if PM2 is installed
    try {
      execSync("pm2 -v", { stdio: "ignore" });
    } catch (e) {
      console.log("PM2 not found. Installing PM2 globally with bun...");
      try {
        execSync("bun install -g pm2", { stdio: "inherit" });
      } catch (err) {
        console.error("Failed to install PM2. Please install it manually: bun install -g pm2");
        process.exit(1);
      }
    }

    // 2. Resolve the path to the daemon
    // In a global install, we want the bundled daemon in dist/daemon/index.js
    let daemonPath: string;
    try {
      // Try to resolve relative to this file first (works in dev and global)
      daemonPath = Bun.resolveSync("./daemon/index.js", import.meta.url);
    } catch (e) {
      // Fallback for some bundling scenarios
      const path = require("path");
      daemonPath = path.join(path.dirname(import.meta.url).replace("file://", ""), "daemon", "index.js");
    }

    if (!existsSync(daemonPath)) {
      console.error(`Could not find daemon at ${daemonPath}. Did you run 'bun run build'?`);
      process.exit(1);
    }

    console.log("Starting routstrd via PM2...");
    try {
      // Use --interpreter bun to ensure it runs with bun
      execSync(`pm2 start "${daemonPath}" --name routstrd --interpreter bun`, {
        stdio: "inherit",
      });

      console.log("\n✅ routstrd is now managed by PM2.");
      console.log("\nTo ensure it starts on system reboot, run:");
      console.log("  pm2 startup");
      console.log("  pm2 save");
      console.log("\nTo view logs:");
      console.log("  pm2 logs routstrd");
    } catch (err) {
      console.error("Failed to start routstrd via PM2.");
      process.exit(1);
    }
  });

serviceCmd
  .command("uninstall")
  .description("Stop and remove routstrd from PM2")
  .action(() => {
    try {
      execSync("pm2 delete routstrd", { stdio: "inherit" });
      console.log("✅ routstrd service removed from PM2.");
    } catch (e) {
      console.error(
        "Failed to remove service. It might not be running in PM2.",
      );
    }
  });

serviceCmd
  .command("logs")
  .description("View PM2 logs for routstrd")
  .action(() => {
    try {
      execSync("pm2 logs routstrd", { stdio: "inherit" });
    } catch (e) {
      // Ignored
    }
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
  .description("Set the client mode (lazyrefund/apikeys or xcashu)")
  .action(async () => {
    const config = await loadConfig();
    const currentMode = config.mode || "apikeys";

    console.log("Select client mode:");
    console.log(
      "  1) lazyrefund/apikeys    - Pseudonymous accounts are kept with the Routstr nodes and are refunded after 5 mins if not used.",
    );
    console.log(
      "  2) xcashu (coming soon)   - Balances are never kept with the nodes, all balances are refunded in response.",
    );
    console.log(`\nCurrent mode: ${currentMode}`);

    const modes: Array<"apikeys" | "xcashu"> = ["apikeys", "xcashu"];

    const selectedIndex = await new Promise<number>((resolve) => {
      const rl = require("readline").createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question("\nEnter choice (1-2): ", (answer: string) => {
        rl.close();
        const num = parseInt(answer, 10);
        resolve(Number.isFinite(num) && num >= 1 && num <= 2 ? num - 1 : 0);
      });
    });

    const selectedMode = modes[selectedIndex];

    if (selectedMode === "xcashu") {
      console.log(
        "\nxcashu mode is coming soon! Only lazyrefund/apikeys is available at this time.",
      );
      return;
    }

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
function getLogFileForDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${LOGS_DIR}/${year}-${month}-${day}.log`;
}

program
  .command("logs")
  .description("View daemon logs")
  .option("-f, --follow", "Follow log output", false)
  .option("-n, --lines <number>", "Number of lines to show", "50")
  .action(async (options: { follow: boolean; lines: string }) => {
    const todayFile = getLogFileForDate();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayFile = getLogFileForDate(yesterday);

    if (!existsSync(todayFile) && !existsSync(yesterdayFile)) {
      console.log("No log files found. Daemon may not have started yet.");
      console.log(`Logs directory: ${LOGS_DIR}`);
      process.exit(1);
    }

    const lines = parseInt(options.lines, 10);

    const logFiles = [yesterdayFile, todayFile].filter((file, index, files) => {
      return existsSync(file) && files.indexOf(file) === index;
    });

    if (options.follow) {
      const proc = Bun.spawn(["tail", "-n", String(lines), "-f", todayFile], {
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });

      const exitCode = await proc.exited;
      process.exit(exitCode);
    }

    const proc = Bun.spawn(["tail", "-n", String(lines), ...logFiles], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });

    const exitCode = await proc.exited;
    process.exit(exitCode);
  });

export function cli(args: string[]) {
  program.parse(args);
}
