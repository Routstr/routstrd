import { createServer } from "http";
import { existsSync } from "fs";
import {
  ModelManager,
  createDiscoveryAdapterFromStore,
  createProviderRegistryFromStore,
  createStorageAdapterFromStore,
  createSdkStore,
} from "@routstr/sdk";
import { DB_PATH, SOCKET_PATH, PID_FILE } from "../utils/config";
import { logger } from "../utils/logger";
import { parseArgs } from "./args";
import {
  ensureDirs,
  loadDaemonConfig,
  saveDaemonConfig,
} from "./config-store";
import { createBunSqliteDriver } from "./sqlite-driver";
import { createWalletAdapter } from "./wallet";
import { createCocodClient } from "./wallet/cocod-client";
import { createModelService } from "./models";
import { createDaemonRequestHandler } from "./http";

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const config = await loadDaemonConfig();

  const port = args.port;
  const provider = args.provider || config.provider;

  await ensureDirs();

  const updatedConfig = { ...config, port, provider };
  saveDaemonConfig(updatedConfig);

  const sqliteDriver = createBunSqliteDriver(DB_PATH);
  const sdkStore = createSdkStore({ driver: sqliteDriver });
  await sdkStore.hydrate;
  const store = sdkStore.store;

  const discoveryAdapter = createDiscoveryAdapterFromStore(store);
  const providerRegistry = createProviderRegistryFromStore(store);
  const storageAdapter = createStorageAdapterFromStore(store);
  const modelManager = new ModelManager(discoveryAdapter);
  const { ensureProvidersBootstrapped, getRoutstr21Models } =
    createModelService(modelManager);

  const walletClient = createCocodClient({ cocodPath: config.cocodPath });
  const walletAdapter = await createWalletAdapter({
    cocodPath: config.cocodPath,
    walletClient,
  });

  const server = createServer();
  server.on(
    "request",
    createDaemonRequestHandler({
      provider,
      server,
      store,
      walletClient,
      walletAdapter,
      storageAdapter,
      providerRegistry,
      discoveryAdapter,
      modelManager,
      ensureProvidersBootstrapped,
      getRoutstr21Models,
    }),
  );

  Bun.write(PID_FILE, String(process.pid));

  try {
    if (existsSync(SOCKET_PATH)) {
      Bun.spawn(["rm", SOCKET_PATH]);
    }
  } catch {
    // Ignore
  }

  const REFRESH_INTERVAL_MS = 3.5 * 60 * 60 * 1000; // 3.5 hours

  // Recurring job to refresh routstr21 models
  let refreshInterval: ReturnType<typeof setInterval> | null = null;

  const startModelRefreshJob = () => {
    logger.log(
      `Starting recurring model refresh job (every ${REFRESH_INTERVAL_MS / 1000 / 60 / 60} hours)`,
    );

    refreshInterval = setInterval(async () => {
      logger.log("Running scheduled model refresh...");
      try {
        await getRoutstr21Models(true);
        logger.log("Scheduled model refresh completed successfully.");
      } catch (error) {
        logger.error("Scheduled model refresh failed:", error);
      }
    }, REFRESH_INTERVAL_MS);
  };

  const stopModelRefreshJob = () => {
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
      logger.log("Stopped recurring model refresh job.");
    }
  };

  server.on("close", () => {
    stopModelRefreshJob();
  });

  server.listen(port, async () => {
    logger.log(`Routstr daemon listening on http://localhost:${port}`);

    // Start the recurring model refresh job after initial bootstrap
    void ensureProvidersBootstrapped()
      .then(() => {
        startModelRefreshJob();
        // Run an immediate refresh to populate models right away
        logger.log("Running initial model refresh...");
        return getRoutstr21Models(true);
      })
      .then(() => {
        logger.log("Initial model refresh completed.");
      })
      .catch((error) => {
        logger.error("Initial model refresh failed:", error);
        // Still start the job even if initial refresh fails
        startModelRefreshJob();
      });
  });
}

if (import.meta.main) {
  main().catch((error) => {
    logger.error("Failed to start Routstr daemon:", error);
    process.exit(1);
  });
}
