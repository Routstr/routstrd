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
import { readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  CONFIG_DIR,
  DB_PATH,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  type RoutstrdConfig,
} from "./utils/config";
import { logger } from "./utils/logger";

const OPENCODE_CONFIG_PATH = join(process.env.HOME || "", ".config/opencode/opencode.json");

const cliVersion = "0.1.0";

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
  await installRoutstrModelsInOpencode(config);

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

async function installRoutstrModelsInOpencode(config: RoutstrdConfig): Promise<void> {
  logger.log("\nInstalling routstr models in opencode.json...");

  const port = config.port || 8008;

  let opencodeConfig: {
    provider?: Record<string, {
      npm?: string;
      name?: string;
      options?: {
        baseURL?: string;
        apiKey?: string;
        includeUsage?: boolean;
      };
      models?: Record<string, { name: string }>;
    }>;
    small_model?: string;
  };

  try {
    if (existsSync(OPENCODE_CONFIG_PATH)) {
      const content = await readFile(OPENCODE_CONFIG_PATH, "utf-8");
      opencodeConfig = JSON.parse(content);
    } else {
      opencodeConfig = { provider: {} };
    }
  } catch {
    opencodeConfig = { provider: {} };
  }

  if (!opencodeConfig.provider) {
    opencodeConfig.provider = {};
  }

  try {
    mkdirSync(dirname(OPENCODE_CONFIG_PATH), { recursive: true });

    const response = await fetch(`http://localhost:${port}/models`);
    const data = await response.json() as { output?: { models: string[] } };
    const models = data.output?.models || [];

    if (models.length === 0) {
      logger.log("No models found from routstr daemon.");
      return;
    }

    const modelsObj: Record<string, { name: string }> = {};
    for (const model of models) {
      modelsObj[model] = { name: model };
    }

    opencodeConfig.provider["routstr"] = {
      npm: "@ai-sdk/openai-compatible",
      name: "routstr",
      options: {
        baseURL: `http://localhost:${port}/`,
        apiKey: "",
        includeUsage: true,
      },
      models: modelsObj,
    };

    await writeFile(OPENCODE_CONFIG_PATH, JSON.stringify(opencodeConfig, null, 2));
    logger.log(`Added "routstr" provider with ${models.length} models to opencode.json`);
  } catch (error) {
    logger.error("Failed to install models in opencode.json:", error);
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
      const models = (result.output as { models: string[] }).models;
      if (models.length === 0) {
        console.log("No routstr21 models found");
      } else {
        console.log(`\nFound ${models.length} routstr21 models:`);
        models.forEach((model, i) => {
          console.log(`${i + 1}. ${model}`);
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
