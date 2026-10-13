import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLIENT_CONFIGS, runIntegrationsForClients } from "../../src/integrations/registry";
import type { RoutstrdConfig } from "../../src/utils/config";

const config = { port: 8008 } as RoutstrdConfig;

describe("integration registry failure accounting", () => {
  for (const clientId of ["opencode", "pi-agent", "openclaw", "claude-code"]) {
    it(`counts a real malformed ${clientId} install as failed, not refreshed`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "registry-failure-"));
      const path = join(dir, "opencode.json");
      const previous = CLIENT_CONFIGS[clientId]!.configPath;
      try {
        writeFileSync(path, "{ not json");
        CLIENT_CONFIGS[clientId]!.configPath = path;
        expect(await runIntegrationsForClients([{ clientId, apiKey: "key" }], config))
          .toEqual({ refreshed: 0, failed: 1 });
        expect(readFileSync(path, "utf8")).toBe("{ not json");
      } finally {
        CLIENT_CONFIGS[clientId]!.configPath = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
