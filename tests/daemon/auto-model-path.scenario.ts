// Scenario runner for auto-model-path.test.ts — executed as a standalone bun
// process with ROUTSTRD_DIR set before module evaluation, because CONFIG_FILE
// is resolved at import time.
import { createServer } from "http";
import type { AddressInfo } from "net";

const { createDaemonRequestHandler } = await import("../../src/daemon/http/index");
const { loadDaemonConfigSync, saveDaemonConfig } = await import(
  "../../src/daemon/config-store"
);

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`ASSERT-FAIL: ${msg}`);
    process.exit(1);
  }
}

/**
 * Build handler deps with an explicit startup value for autoModelPath (the
 * daemon captures it once at boot), so the scenario can observe the difference
 * between "configured on disk" and "in effect right now".
 */
function stubDeps(autoModelPath: boolean) {
  return {
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
    autoModelPath,
    usageTrackingDriver: {},
    providerManager: {},
    refundClient: {},
  };
}

async function withServer(
  autoModelPath: boolean,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(
    createDaemonRequestHandler(stubDeps(autoModelPath) as never),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    server.close();
  }
}

type SettingBody = {
  output?: {
    autoModelPath?: boolean;
    configured?: boolean;
    restartRequired?: boolean;
    message?: string;
  };
};

const scenario = process.argv[2];

switch (scenario) {
  // The daemon started with the setting off, the operator turns it on: the
  // value must be persisted and flagged as needing a restart.
  case "enable-from-off": {
    await withServer(false, async (port) => {
      const get = async () =>
        (await (
          await fetch(`http://127.0.0.1:${port}/settings/auto-model-path`)
        ).json()) as SettingBody;
      const post = async (body: unknown) =>
        (await (
          await fetch(`http://127.0.0.1:${port}/settings/auto-model-path`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        ).json()) as SettingBody;

      assert(
        loadDaemonConfigSync().autoModelPath === false,
        "autoModelPath must default to false",
      );

      const initial = await get();
      assert(initial.output?.autoModelPath === false, "initial active value");
      assert(initial.output?.configured === false, "initial configured value");
      assert(
        initial.output?.restartRequired === false,
        "a fresh install must not report a pending restart",
      );

      const enabled = await post({ enabled: true });
      assert(
        enabled.output?.autoModelPath === true,
        "enable response did not report the new value",
      );
      assert(
        enabled.output?.restartRequired === true,
        "enabling requires a restart of the running daemon",
      );
      assert(
        loadDaemonConfigSync().autoModelPath === true,
        "enable was not persisted to config.json",
      );

      const after = await get();
      assert(
        after.output?.autoModelPath === false,
        "the running daemon must still report the boot-time value",
      );
      assert(after.output?.configured === true, "configured value after enable");
      assert(
        after.output?.restartRequired === true,
        "pending restart after enable",
      );
    });
    break;
  }

  // The daemon started with the setting on (config.json holds that value), the
  // operator turns it off, and also posts the value the daemon already uses
  // (which needs no restart).
  case "disable-from-on": {
    saveDaemonConfig({
      port: 8008,
      host: "127.0.0.1",
      provider: null,
      autoModelPath: true,
    });

    await withServer(true, async (port) => {
      const get = async () =>
        (await (
          await fetch(`http://127.0.0.1:${port}/settings/auto-model-path`)
        ).json()) as SettingBody;
      const post = async (body: unknown) =>
        (await (
          await fetch(`http://127.0.0.1:${port}/settings/auto-model-path`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        ).json()) as SettingBody;

      const initial = await get();
      assert(initial.output?.autoModelPath === true, "initial active value");
      assert(
        initial.output?.restartRequired === false,
        "a daemon started with autoModelPath on needs no restart",
      );

      const noop = await post({ enabled: true });
      assert(
        noop.output?.restartRequired === false,
        "re-posting the active value must not request a restart",
      );
      assert(
        noop.output?.message === "Auto model path enabled.",
        `unexpected message: ${noop.output?.message}`,
      );

      const disabled = await post({ enabled: false });
      assert(
        disabled.output?.restartRequired === true,
        "disabling requires a restart of the running daemon",
      );
      assert(
        loadDaemonConfigSync().autoModelPath === false,
        "disable was not persisted to config.json",
      );

      const after = await get();
      assert(after.output?.autoModelPath === true, "active value after disable");
      assert(after.output?.configured === false, "configured value after disable");
      assert(after.output?.restartRequired === true, "pending restart");
    });
    break;
  }

  default:
    console.error(`unknown scenario: ${scenario}`);
    process.exit(2);
}

console.log("SCENARIO-OK");
