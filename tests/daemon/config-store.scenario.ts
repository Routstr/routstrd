// Scenario runner for config-store.perms.test.ts — executed as a standalone
// bun process with ROUTSTRD_DIR set before module evaluation. Not a test file.
import {
  chmodSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";

const { CONFIG_DIR, CONFIG_FILE } = await import("../../src/utils/config");
const {
  ensureDirs,
  ensureDirsSync,
  loadDaemonConfig,
  loadDaemonConfigSync,
  saveDaemonConfig,
  REQUESTS_DIR,
} = await import("../../src/daemon/config-store");

const modeOf = (p: string): number => statSync(p).mode & 0o777;

const baseConfig = {
  port: 8008,
  host: "127.0.0.1",
  provider: null,
  cocodPath: null,
};

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`ASSERT-FAIL: ${msg}`);
    process.exit(1);
  }
}

const scenario = process.argv[2];

switch (scenario) {
  case "fresh-install": {
    saveDaemonConfig({
      ...baseConfig,
      nsec: "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    });
    assert(modeOf(CONFIG_DIR) === 0o700, `dir mode ${modeOf(CONFIG_DIR).toString(8)} != 700`);
    assert(modeOf(CONFIG_FILE) === 0o600, `file mode ${modeOf(CONFIG_FILE).toString(8)} != 600`);
    assert(
      readdirSync(CONFIG_DIR).filter((f) => f.endsWith(".tmp")).length === 0,
      "temp file left behind",
    );
    const loaded = await loadDaemonConfig();
    assert(
      loaded.nsec === "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
      "nsec round-trip failed",
    );
    assert(loaded.port === 8008, "port round-trip failed");

    await ensureDirs();
    assert(modeOf(CONFIG_DIR) === 0o700, "ensureDirs dir mode");
    assert(modeOf(REQUESTS_DIR) === 0o700, "ensureDirs requests dir mode");
    break;
  }

  case "repair-perms": {
    // Simulate an install written by the vulnerable version.
    ensureDirsSync();
    writeFileSync(CONFIG_FILE, JSON.stringify(baseConfig), { mode: 0o644 });
    chmodSync(CONFIG_DIR, 0o755);
    chmodSync(CONFIG_FILE, 0o644);
    assert(modeOf(CONFIG_FILE) === 0o644, "setup: file not 0644");

    // Load repairs the file mode...
    loadDaemonConfigSync();
    assert(modeOf(CONFIG_FILE) === 0o600, "load did not repair file mode");

    // ...and the next save repairs the directory mode too.
    chmodSync(CONFIG_DIR, 0o755);
    saveDaemonConfig({ ...baseConfig, port: 9009 });
    assert(modeOf(CONFIG_DIR) === 0o700, "save did not repair dir mode");
    assert(modeOf(CONFIG_FILE) === 0o600, "save did not keep file mode");
    assert(loadDaemonConfigSync().port === 9009, "save did not persist port");
    break;
  }

  case "write-failure": {
    // Turn the config dir into a regular file: mkdir fails and no temp write
    // can succeed, so saveDaemonConfig must surface the error synchronously.
    writeFileSync(process.env.ROUTSTRD_DIR!, "blocked");
    let threw = false;
    try {
      saveDaemonConfig(baseConfig);
    } catch {
      threw = true;
    }
    assert(threw, "saveDaemonConfig did not throw on unwritable target");
    break;
  }

  case "corrupt-json": {
    ensureDirsSync();
    writeFileSync(CONFIG_FILE, "{ not json");
    const loaded = await loadDaemonConfig();
    assert(loaded.port === 8008, "did not fall back to defaults");
    assert(existsSync(CONFIG_FILE), "config file vanished");
    break;
  }

  default:
    console.error(`unknown scenario: ${scenario}`);
    process.exit(2);
}

console.log("SCENARIO-OK");
