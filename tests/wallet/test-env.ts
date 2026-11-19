import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Test-wide environment root. Must be imported before any src module that
 * captures env vars at load time (src/utils/logger reads ROUTSTRD_DIR when
 * the module is first evaluated), so log output lands in a temp directory
 * instead of the real ~/.routstrd.
 */
export const TEST_ROOT = mkdtempSync(join(tmpdir(), "routstrd-test-env-"));
process.env.ROUTSTRD_DIR = join(TEST_ROOT, "routstrd");
