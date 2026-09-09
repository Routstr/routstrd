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
 * Whether this process is a `bun build --compile` standalone binary.
 *
 * Always false on Deno: standalone binaries are only produced by Bun, so a Deno
 * process is by definition running from source or from an installed script.
 */
export function isStandaloneExecutable(
  runtime: BunRuntime | undefined = RUNTIME === "deno"
    ? undefined
    : (globalThis as unknown as { Bun: BunRuntime }).Bun,
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
