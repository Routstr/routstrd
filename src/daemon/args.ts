export function parseArgs(argv: string[]): {
  port: number;
  host: string | null;
  provider: string | null;
} {
  const portFlagIndex = argv.findIndex((arg) => arg === "--port");
  const hostFlagIndex = argv.findIndex((arg) => arg === "--host");
  const providerFlagIndex = argv.findIndex(
    (arg) => arg === "--provider" || arg === "-p",
  );

  const port =
    portFlagIndex !== -1
      ? Number.parseInt(argv[portFlagIndex + 1] || "8008", 10)
      : 8008;

  // --host flag takes precedence, then ROUTSTRD_HOST env var
  const hostValue =
    hostFlagIndex !== -1 ? argv[hostFlagIndex + 1] : undefined;
  const host = hostValue ? hostValue.trim() : (process.env.ROUTSTRD_HOST || null);

  const providerValue =
    providerFlagIndex !== -1 ? argv[providerFlagIndex + 1] : undefined;
  const provider = providerValue ? providerValue.trim() : null;

  return { port, host, provider };
}
