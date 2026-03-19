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
import {
  createWalletAdapter,
  parseBalances,
  runWalletCommand,
} from "./wallet";
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
  const store = await createSdkStore({ driver: sqliteDriver });

  const discoveryAdapter = createDiscoveryAdapterFromStore(store);
  const providerRegistry = createProviderRegistryFromStore(store);
  const storageAdapter = createStorageAdapterFromStore(store);
  const modelManager = new ModelManager(discoveryAdapter);
  const { ensureProvidersBootstrapped, getRoutstr21Models } =
    createModelService(modelManager);

  void ensureProvidersBootstrapped().catch(() => {
    // Error is already logged; keep daemon alive for troubleshooting/retries.
  });

  const walletAdapter = await createWalletAdapter();

  const server = createServer();
  server.on(
    "request",
    createDaemonRequestHandler({
      provider,
      server,
      store,
      walletAdapter,
      storageAdapter,
      providerRegistry,
      discoveryAdapter,
      modelManager,
      ensureProvidersBootstrapped,
      getRoutstr21Models,
      runWalletCommand,
      parseBalances,
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

  server.listen(port, async () => {
    logger.log(`Routstr daemon listening on http://localhost:${port}`);
  });
}

if (import.meta.main) {
  main().catch((error) => {
    logger.error("Failed to start Routstr daemon:", error);
    process.exit(1);
  });
}
