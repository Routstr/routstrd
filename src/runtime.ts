import { fileURLToPath } from "node:url";

export const DAEMON_COMMAND = "daemon";

export type RuntimeName = "bun" | "deno";

/** Which JavaScript runtime this process is executing under. */
export const RUNTIME: RuntimeName =
  typeof (globalThis as { Deno?: unknown }).Deno !== "undefined" &&
    typeof (globalThis as { Bun?: unknown }).Bun === "undefined"
    ? "deno"
    : "bun";

type BunRuntime = {
  isStandaloneExecutable?: boolean;
  main: string;
};

type DenoRuntime = {
  build?: { standalone?: boolean };
  mainModule?: string;
};

/**
 * Normalise whichever runtime we are on into the Bun-shaped record
 * `isStandaloneExecutable()` inspects.
 */
function standaloneMarker(): BunRuntime | undefined {
  if (RUNTIME === "deno") {
    const deno = (globalThis as { Deno?: DenoRuntime }).Deno;
    return {
      // Set on `deno compile` binaries, false under `deno run`.
      isStandaloneExecutable: deno?.build?.standalone === true,
      main: deno?.mainModule ?? "",
    };
  }
  return (globalThis as unknown as { Bun: BunRuntime }).Bun;
}

/**
 * Path of the entry module.
 *
 * Deno exposes this as a `file://` URL rather than a path, so it is converted
 * to match `Bun.main`.
 */
export function mainModule(): string {
  if (RUNTIME === "deno") {
    const deno = (globalThis as { Deno?: { mainModule: string } }).Deno;
    const url = deno?.mainModule ?? "";
    return url.startsWith("file://") ? fileURLToPath(url) : url;
  }
  return (globalThis as unknown as { Bun: BunRuntime }).Bun.main;
}

/**
 * Whether this process is a compiled standalone binary, from either
 * `bun build --compile` or `deno compile`.
 */
export function isStandaloneExecutable(
  runtime: BunRuntime | undefined = standaloneMarker(),
): boolean {
  if (!runtime) return false;
  return (
    runtime.isStandaloneExecutable === true ||
    runtime.main.startsWith("/$bunfs/")
  );
}

type RuntimeExecutable = {
  standalone: boolean;
  execPath: string;
  main: string;
  runtime?: RuntimeName;
};

function defaultRuntimeExecutable(): RuntimeExecutable {
  return {
    standalone: isStandaloneExecutable(),
    execPath: process.execPath,
    main: mainModule(),
    runtime: RUNTIME,
  };
}

export function daemonSpawnCommand(
  args: string[],
  runtime: RuntimeExecutable = defaultRuntimeExecutable(),
): string[] {
  if (runtime.standalone) return [runtime.execPath, DAEMON_COMMAND, ...args];
  // `deno run` needs the subcommand and permissions before the script path.
  if (runtime.runtime === "deno") {
    return [runtime.execPath, "run", "-A", runtime.main, DAEMON_COMMAND, ...args];
  }
  return [runtime.execPath, runtime.main, DAEMON_COMMAND, ...args];
}

export function pm2DaemonArgs(
  runtime: RuntimeExecutable = defaultRuntimeExecutable(),
): string[] {
  const entrypoint = runtime.standalone ? runtime.execPath : runtime.main;
  const interpreter = runtime.standalone ? "none" : runtime.execPath;
  const args = [
    "start",
    entrypoint,
    "--name",
    "routstrd",
    "--interpreter",
    interpreter,
  ];
  // PM2 passes the script straight to the interpreter, so Deno needs its
  // subcommand and permission flags supplied as interpreter arguments.
  if (!runtime.standalone && runtime.runtime === "deno") {
    args.push("--interpreter-args", "run -A");
  }
  args.push("--", DAEMON_COMMAND);
  return args;
}

/** Command that installs (or upgrades) a package globally for this runtime. */
export function globalInstallCommand(
  packageName: string,
  runtime: RuntimeName = RUNTIME,
): string[] {
  return runtime === "deno"
    ? ["deno", "install", "-gAf", `npm:${packageName}`]
    : ["bun", "install", "-g", packageName];
}

/**
 * Command that installs PM2 globally.
 *
 * PM2 cannot be installed with `deno install`: the resulting shim runs PM2
 * itself under Deno, where it first trips over `Object.prototype.__proto__`
 * (disabled by default) and then, even with `--unstable-unsafe-proto`, dies in
 * Deno's `node:net` polyfill with `EINVAL` when its RPC daemon connects to
 * pm2_home's unix sockets. PM2 has to run under Node, so install it with npm
 * and leave Deno to act only as the interpreter PM2 spawns for the daemon
 * (see `pm2DaemonArgs`).
 */
export function pm2InstallCommand(
  runtime: RuntimeName = RUNTIME,
): string[] {
  return runtime === "deno"
    ? ["npm", "install", "-g", "pm2"]
    : globalInstallCommand("pm2", runtime);
}
