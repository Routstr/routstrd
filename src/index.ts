#!/usr/bin/env bun
// Must stay the first import: @peculiar/x509 (the SDK's confidential TLS client)
// needs it before tsyringe loads, and the bundler runs that package's own import
// of it too late in dist/.
import "reflect-metadata";
import { cli } from "./cli";

try {
  await cli(process.argv);
} catch (error) {
  console.error(
    "routstrd command failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}
