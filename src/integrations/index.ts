import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import { installOpencodeIntegration } from "./opencode";
import { installOpenClawIntegration } from "./openclaw";
import { installPiIntegration } from "./pi";
import type { SdkStore } from "@routstr/sdk";

function ask(question: string): Promise<string> {
  process.stdout.write(question);

  if (!process.stdin.isTTY) {
    return Promise.resolve("1");
  }

  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolve(data.toString().trim());
    });
  });
}

function parseChoice(input: string): number {
  if (input === "") {
    return 1;
  }

  const parsed = Number.parseInt(input, 10);
  if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 4) {
    return parsed;
  }

  return 1;
}

export async function setupIntegration(
  config: RoutstrdConfig,
  store: SdkStore,
): Promise<void> {
  logger.log("\nChoose an integration to set up:");
  logger.log("1. OpenCode (default)");
  logger.log("2. OpenClaw");
  logger.log("3. Pi");
  logger.log("4. Skip for now");

  const answer = await ask("Select integration [1]: ");
  const choice = parseChoice(answer);

  if (choice === 1) {
    await installOpencodeIntegration(config, store);
    return;
  }

  if (choice === 2) {
    await installOpenClawIntegration(config, store);
    return;
  }

  if (choice === 3) {
    await installPiIntegration(config, store);
    return;
  }

  logger.log("Skipping integration setup.");
}
