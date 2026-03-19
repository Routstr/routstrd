import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  type RoutstrdConfig,
} from "../utils/config";
import { logger } from "../utils/logger";

export const REQUESTS_DIR = `${CONFIG_DIR}/requests`;

export async function ensureDirs(): Promise<void> {
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await mkdir(REQUESTS_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

export async function loadDaemonConfig(): Promise<RoutstrdConfig> {
  try {
    if (existsSync(CONFIG_FILE)) {
      const content = await Bun.file(CONFIG_FILE).text();
      return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
    }
  } catch (error) {
    logger.error("Failed to load config:", error);
  }
  return DEFAULT_CONFIG;
}

export function saveDaemonConfig(config: RoutstrdConfig): void {
  Bun.write(CONFIG_FILE, JSON.stringify(config, null, 2));
}
