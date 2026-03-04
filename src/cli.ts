import { startDaemon } from "./daemon";
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
  type RoutstrdConfig,
} from "./utils/config";
import { logger } from "./utils/logger";
import { setupIntegration } from "./integrations";

type RoutstrModel = {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
};

const cliVersion = "0.1.0";

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
      logger.error("Failed to install cocod. Please run 'bun install --global cocod' manually.");
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

  const [initCode] = await Promise.all([initProc.exited, stdoutDone, stderrDone]);
  const combinedOutput = `${initStdout}\n${initStderr}`.toLowerCase();
  const alreadyInitialized = combinedOutput.includes("already initialized");

  if (initCode !== 0 && !alreadyInitialized) {
    logger.error("Failed to initialize cocod. Please run 'cocod init' manually.");
    return;
  }

  if (alreadyInitialized) {
    logger.log("cocod is already initialized.");
  } else {
    logger.log("cocod initialized successfully.");
  }

  const config = await loadConfig();
  await startDaemon({ port: String(config.port || 8008) });
  await setupIntegration(config);

  logger.log("\nInitialization complete!");
  logger.log(`Run 'routstrd daemon' to start the daemon.`);
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

// Init - initialize the daemon
program
  .command("init")
  .description("Initialize routstrd (creates config directory and initializes cocod)")
  .action(async () => {
    await initDaemon();
  });

// Daemon - start the background daemon
program
  .command("daemon")
  .description("Start the background daemon")
  .option("--port <port>", "Port to listen on", "8008")
  .option("-p, --provider <provider>", "Default provider to use")
  .action(async (options: { port?: string; provider?: string }) => {
    if (!(await checkCocodInstalled())) {
      logger.error("cocod is not installed. Run 'routstrd init' first to install cocod.");
      process.exit(1);
    }
    await startDaemon(options);
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

    console.log("=== Wallet Balance ===");
    if (walletResult.output) {
      if (typeof walletResult.output === "string") {
        console.log(walletResult.output);
      } else {
        console.log(JSON.stringify(walletResult.output, null, 2));
      }
    } else if (walletResult.error) {
      console.error("Wallet error:", walletResult.error);
    }

    console.log("\n=== API Key Balances ===");
    if (keysResult.output && typeof keysResult.output === "object" && "keys" in keysResult.output) {
      const keys = (keysResult.output as { keys: Array<{ id: string; name: string; balance: number }> }).keys;
      if (keys.length === 0) {
        console.log("No API keys found");
      } else {
        for (const key of keys) {
          console.log(`${key.name}: ${key.balance} sats`);
        }
      }
      const apikeysCalled = (keysResult.output as { apikeysCalled?: number }).apikeysCalled;
      if (apikeysCalled !== undefined) {
        console.log(`\nAPI Keys Called: ${apikeysCalled}`);
      }
    } else if (keysResult.error) {
      console.error("Keys error:", keysResult.error);
    }
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
  .action(async () => {
    await ensureDaemonRunning();
    
    const result = await callDaemon("/models");
    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    if (result.output && typeof result.output === "object" && "models" in result.output) {
      const models = (result.output as { models: RoutstrModel[] }).models;
      if (models.length === 0) {
        console.log("No routstr21 models found");
      } else {
        console.log(`\nFound ${models.length} routstr21 models:`);
        models.forEach((model, i) => {
          const details = [
            model.name && model.name !== model.id ? model.name : null,
            model.context_length ? `${model.context_length} ctx` : null,
          ].filter(Boolean).join(" - ");
          console.log(`${i + 1}. ${model.id}${details ? ` (${details})` : ""}`);
        });
      }
    }
  });

// Stop
program
  .command("stop")
  .description("Stop the background daemon")
  .action(async () => {
    await handleDaemonCommand("/stop", { method: "POST" });
  });

export function cli(args: string[]) {
  program.parse(args);
}
