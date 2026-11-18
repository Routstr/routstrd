// Scenario runner for auto-refresh.test.ts — executed as a standalone bun
// process with ROUTSTRD_DIR set before module evaluation, because CONFIG_FILE
// is resolved at import time.
import { createServer } from "http";
import type { AddressInfo } from "net";

const { createDaemonRequestHandler } = await import("../../src/daemon/http/index");
const { loadDaemonConfigSync } = await import("../../src/daemon/config-store");

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`ASSERT-FAIL: ${msg}`);
    process.exit(1);
  }
}

/**
 * Only the settings endpoints are exercised, so every daemon dependency is a
 * stub that would throw loudly if the request reached the proxy path.
 */
const stubDeps = {
  provider: null,
  server: { close() {} },
  store: {},
  walletClient: {},
  walletAdapter: {},
  storageAdapter: {},
  discoveryAdapter: {},
  modelManager: {},
  ensureProvidersBootstrapped: async () => {},
  getRoutstr21Models: async () => [],
  getModelProviders: async () => [],
  refreshProvidersAndModels: async () => {},
  mode: "apikeys" as const,
  maxTokens: 64000,
  usageTrackingDriver: {},
  providerManager: {},
  refundClient: {},
};

async function withServer(
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(
    createDaemonRequestHandler(stubDeps as never),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    server.close();
  }
}

const scenario = process.argv[2];

switch (scenario) {
  case "toggle-endpoint": {
    await withServer(async (port) => {
      const post = (body: unknown) =>
        fetch(`http://127.0.0.1:${port}/settings/auto-refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      // Missing config means "enabled" so existing installs are unaffected.
      assert(
        loadDaemonConfigSync().autoRefresh?.enabled === undefined,
        "expected no autoRefresh in a fresh config",
      );

      const disabled = await post({ enabled: false });
      assert(disabled.status === 200, `disable status ${disabled.status}`);
      const disabledBody = (await disabled.json()) as {
        output?: { autoRefresh?: { enabled?: boolean } };
      };
      assert(
        disabledBody.output?.autoRefresh?.enabled === false,
        "disable response did not report enabled=false",
      );
      assert(
        loadDaemonConfigSync().autoRefresh?.enabled === false,
        "disable was not persisted to config.json",
      );

      const enabled = await post({ enabled: true });
      assert(enabled.status === 200, `enable status ${enabled.status}`);
      assert(
        loadDaemonConfigSync().autoRefresh?.enabled === true,
        "enable was not persisted to config.json",
      );
    });
    break;
  }

  default:
    console.error(`unknown scenario: ${scenario}`);
    process.exit(2);
}

console.log("SCENARIO-OK");
