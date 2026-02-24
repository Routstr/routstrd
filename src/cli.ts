import { startDaemon } from "./daemon";
import {
  program,
  handleDaemonCommand,
  callDaemon,
  ensureDaemonRunning,
  isDaemonRunning,
} from "./cli-shared";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  CONFIG_DIR,
  DB_PATH,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  type RoutstrdConfig,
} from "./utils/config";

const cliVersion = "0.1.0";

async function initDaemon(): Promise<void> {
  console.log("Initializing routstrd...");

  // Create config directory
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    console.log(`Created config directory: ${CONFIG_DIR}`);
  }

  // Create initial config
  if (!existsSync(CONFIG_FILE)) {
    const config: RoutstrdConfig = {
      ...DEFAULT_CONFIG,
      cocodPath: null,
    };
    Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`Created config file: ${CONFIG_FILE}`);
  }

  console.log(`Database will be stored at: ${DB_PATH}`);
  console.log("\nInitializing cocod...");

  // Initialize cocod
  const initProc = Bun.spawn({
    cmd: ["cocod", "init"],
    stdout: "inherit",
    stderr: "inherit",
  });
  const initCode = await initProc.exited;

  if (initCode !== 0) {
    console.error("Failed to initialize cocod. Please run 'cocod init' manually.");
  } else {
    console.log("cocod initialized successfully.");
  }

  console.log("\nInitialization complete!");
  console.log(`Run 'routstrd daemon' to start the daemon.`);
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
  .action(() => {
    initDaemon();
  });

// Daemon - start the background daemon
program
  .command("daemon")
  .description("Start the background daemon")
  .option("--port <port>", "Port to listen on", "8008")
  .option("-p, --provider <provider>", "Default provider to use")
  .action(async (options: { port?: string; provider?: string }) => {
    if (!checkCocodInstalled()) {
      console.error("cocod is not installed. Run 'routstrd init' first to install cocod.");
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
