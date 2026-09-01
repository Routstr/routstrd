export const DAEMON_COMMAND = "daemon";

export function isStandaloneExecutable(): boolean {
  return (
    Bun as unknown as { isStandaloneExecutable?: boolean }
  ).isStandaloneExecutable === true;
}

type RuntimeExecutable = {
  standalone: boolean;
  execPath: string;
  main: string;
};

export function daemonSpawnCommand(
  args: string[],
  runtime: RuntimeExecutable = {
    standalone: isStandaloneExecutable(),
    execPath: process.execPath,
    main: Bun.main,
  },
): string[] {
  return runtime.standalone
    ? [runtime.execPath, DAEMON_COMMAND, ...args]
    : [runtime.execPath, runtime.main, DAEMON_COMMAND, ...args];
}

export function pm2DaemonArgs(
  runtime: RuntimeExecutable = {
    standalone: isStandaloneExecutable(),
    execPath: process.execPath,
    main: Bun.main,
  },
): string[] {
  const entrypoint = runtime.standalone ? runtime.execPath : runtime.main;
  const interpreter = runtime.standalone ? "none" : runtime.execPath;
  return [
    "start",
    entrypoint,
    "--name",
    "routstrd",
    "--interpreter",
    interpreter,
    "--",
    DAEMON_COMMAND,
  ];
}
