#!/usr/bin/env bun
import { cli } from "./cli.ts";

try {
  await cli(process.argv);
} catch (error) {
  console.error(
    "routstrd command failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}
