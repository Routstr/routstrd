export function parseArgs(argv: string[]): {
  port: number | null;
  host: string | null;
  provider: string | null;
} {
  const portFlagIndex = argv.findIndex((arg) => arg === "--port");
  const hostFlagIndex = argv.findIndex((arg) => arg === "--host");
  const providerFlagIndex = argv.findIndex(
    (arg) => arg === "--provider" || arg === "-p",
  );

  const portValue = portFlagIndex !== -1 ? argv[portFlagIndex + 1] : undefined;
  const parsedPort = portValue ? Number.parseInt(portValue, 10) : Number.NaN;
  const port = Number.isInteger(parsedPort) ? parsedPort : null;

  const hostValue =
    hostFlagIndex !== -1 ? argv[hostFlagIndex + 1] : undefined;
  const host = hostValue?.trim() || null;

  const providerValue =
    providerFlagIndex !== -1 ? argv[providerFlagIndex + 1] : undefined;
  const provider = providerValue ? providerValue.trim() : null;

  return { port, host, provider };
}
