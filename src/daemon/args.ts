export function parseArgs(argv: string[]): {
  port: number | null;
  provider: string | null;
} {
  const portFlagIndex = argv.findIndex((arg) => arg === "--port");
  const providerFlagIndex = argv.findIndex(
    (arg) => arg === "--provider" || arg === "-p",
  );

  // Only use the CLI flag port if explicitly passed; otherwise fall back to
  // the persisted config so a restart doesn't clobber the user's setting.
  const port =
    portFlagIndex !== -1
      ? Number.parseInt(argv[portFlagIndex + 1] || "8008", 10)
      : null;
  const providerValue =
    providerFlagIndex !== -1 ? argv[providerFlagIndex + 1] : undefined;
  const provider = providerValue ? providerValue.trim() : null;

  return { port, provider };
}
