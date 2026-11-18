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

/** Values the handler passed to the routing implementation, oldest first. */
const routedAutoModelPath: boolean[] = [];

/**
 * Build handler deps with an explicit startup value for autoModelPath (that is
 * what the daemon boots with) plus a stub routing implementation, so the
 * scenario can observe the value routing actually receives.
 */
function stubDeps(autoModelPath: boolean) {
  return {
    provider: null,
    server: { close() {} },
    store: { getState: () => ({}) },
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
    routeRequests: async (params: { autoModelPath?: boolean }) => {
      routedAutoModelPath.push(params.autoModelPath === true);
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
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
  error?: string;
};

function client(port: number) {
  const get = async () =>
    (await (
      await fetch(`http://127.0.0.1:${port}/settings/auto-model-path`)
    ).json()) as SettingBody;

  const post = async (body: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/settings/auto-model-path`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as SettingBody,
    };
  };

  /** Drive one routed request so the scenario sees what routing was given. */
  const route = async () => {
    routedAutoModelPath.length = 0;
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v4.1-flash",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    );
    await response.text();
    assert(
      response.status === 200,
      `routing request failed: ${response.status}`,
    );
    assert(
      routedAutoModelPath.length === 1,
      `expected one routed request, got ${routedAutoModelPath.length}`,
    );
    return routedAutoModelPath[0];
  };

  return { get, post, route };
}

const scenario = process.argv[2];

switch (scenario) {
  // The daemon started with the setting off, the operator turns it on: the value
  // must be persisted, reported as the live value, and used by the very next
  // routed request — without a restart.
  case "enable-applies-live": {
    await withServer(false, async (port) => {
      const api = client(port);

      assert(
        loadDaemonConfigSync().autoModelPath === false,
        "autoModelPath must default to false",
      );

      const initial = await api.get();
      assert(initial.output?.autoModelPath === false, "initial live value");
      assert(initial.output?.configured === false, "initial configured value");
      assert(
        initial.output?.restartRequired === undefined,
        "restartRequired must be gone: the setting is applied live",
      );
      assert((await api.route()) === false, "routing starts without the flag");

      const enabled = await api.post({ enabled: true });
      assert(enabled.status === 200, `enable status: ${enabled.status}`);
      assert(
        enabled.body.output?.autoModelPath === true,
        "enable response must report the new live value",
      );
      assert(
        enabled.body.output?.configured === true,
        "enable response must report the persisted value",
      );
      assert(
        enabled.body.output?.message === "Auto model path enabled.",
        `unexpected message: ${enabled.body.output?.message}`,
      );
      assert(
        loadDaemonConfigSync().autoModelPath === true,
        "enable was not persisted to config.json",
      );

      const after = await api.get();
      assert(after.output?.autoModelPath === true, "live value after enable");
      assert(after.output?.configured === true, "configured after enable");
      assert(
        (await api.route()) === true,
        "the next routed request must receive autoModelPath: true",
      );
    });
    break;
  }

  // The daemon started with the setting on, the operator turns it off; the next
  // routed request must stop using it.
  case "disable-applies-live": {
    saveDaemonConfig({
      port: 8008,
      host: "127.0.0.1",
      provider: null,
      autoModelPath: true,
    });

    await withServer(true, async (port) => {
      const api = client(port);

      const initial = await api.get();
      assert(initial.output?.autoModelPath === true, "initial live value");
      assert(initial.output?.configured === true, "initial configured value");
      assert((await api.route()) === true, "routing starts with the flag");

      // Posting the value the daemon already uses is a no-op for routing.
      const noop = await api.post({ enabled: true });
      assert(noop.status === 200, `no-op status: ${noop.status}`);
      assert(noop.body.output?.autoModelPath === true, "no-op live value");

      const disabled = await api.post({ enabled: false });
      assert(disabled.status === 200, `disable status: ${disabled.status}`);
      assert(
        disabled.body.output?.autoModelPath === false,
        "disable response must report the new live value",
      );
      assert(
        loadDaemonConfigSync().autoModelPath === false,
        "disable was not persisted to config.json",
      );
      assert((await api.route()) === false, "routing must drop the flag");
    });
    break;
  }

  // `configured` reports the file, `autoModelPath` the running value: only a
  // hand-edited config.json can make them disagree, and that still needs a
  // restart to take effect.
  case "reports-hand-edited-config": {
    await withServer(false, async (port) => {
      const api = client(port);
      saveDaemonConfig({ ...loadDaemonConfigSync(), autoModelPath: true });

      const body = await api.get();
      assert(
        body.output?.autoModelPath === false,
        "live value must stay the boot value",
      );
      assert(
        body.output?.configured === true,
        "configured must report the hand-edited file",
      );
      assert(
        (await api.route()) === false,
        "routing keeps using the live value until a restart",
      );
    });
    break;
  }

  // A payload that is not a boolean must be rejected instead of silently
  // disabling routing behaviour.
  case "rejects-invalid-body": {
    saveDaemonConfig({
      port: 8008,
      host: "127.0.0.1",
      provider: null,
      autoModelPath: true,
    });

    await withServer(true, async (port) => {
      const api = client(port);

      for (const body of [
        {},
        { enabled: "yes" },
        { enabled: "true" },
        { enabled: 1 },
        { enabled: 0 },
        { enabled: null },
        { enable: true },
      ]) {
        const response = await api.post(body);
        assert(
          response.status === 400,
          `expected 400 for ${JSON.stringify(body)}, got ${response.status}`,
        );
        assert(
          response.body.error === "'enabled' must be a boolean.",
          `unexpected error for ${JSON.stringify(body)}: ${response.body.error}`,
        );
        assert(
          loadDaemonConfigSync().autoModelPath === true,
          `a rejected body must not change config.json: ${JSON.stringify(body)}`,
        );
      }

      assert(
        (await api.route()) === true,
        "a rejected write must not change routing",
      );
    });
    break;
  }

  default:
    console.error(`unknown scenario: ${scenario}`);
    process.exit(2);
}

console.log("SCENARIO-OK");
