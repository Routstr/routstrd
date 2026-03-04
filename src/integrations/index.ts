import type { RoutstrdConfig } from "../utils/config";
import { logger } from "../utils/logger";
import { installOpencodeIntegration } from "./opencode";
import { installOpenClawIntegration } from "./openclaw";

function ask(question: string): Promise<string> {
  process.stdout.write(question);

  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim());
    });
  });
}

function parseChoice(input: string): number {
  if (input === "") {
    return 1;
  }

  const parsed = Number.parseInt(input, 10);
  if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 3) {
    return parsed;
  }

  return 1;
}

export async function setupIntegration(config: RoutstrdConfig): Promise<void> {
  logger.log("\nChoose an integration to set up:");
  logger.log("1. OpenCode (default)");
  logger.log("2. OpenClaw");
  logger.log("3. Skip for now");

  const answer = await ask("Select integration [1]: ");
  const choice = parseChoice(answer);

  if (choice === 1) {
    await installOpencodeIntegration(config);
    return;
  }

  if (choice === 2) {
    await installOpenClawIntegration(config);
    return;
  }

  logger.log("Skipping integration setup.");
}
