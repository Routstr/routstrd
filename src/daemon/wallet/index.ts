import { spawn } from "child_process";
import { getDecodedToken } from "@cashu/cashu-ts";
import { logger } from "../../utils/logger";

export async function runWalletCommand(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("cocod", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code && code !== 0) {
        reject(
          new Error(stderr.trim() || stdout.trim() || "Wallet CLI failed"),
        );
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export function parseBalances(output: string): Record<string, number> {
  const trimmed = output.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as Record<
      string,
      { sats?: number } | number
    >;
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(
        Object.entries(parsed).map(([mintUrl, value]) => {
          if (typeof value === "number") {
            return [mintUrl, value];
          }
          if (value && typeof value === "object" && "sats" in value) {
            return [mintUrl, Number(value.sats ?? 0)];
          }
          return [mintUrl, 0];
        }),
      );
    }
  } catch {
    // Fall back to line parsing.
  }

  const balances: Record<string, number> = {};
  trimmed
    .split("\n")
    .map((line) => line.trim())
    .forEach((line) => {
      const match = line.match(/^(\S+):\s+(\d+)\s+s$/);
      const mintUrl = match?.[1];
      const amount = match?.[2];
      if (mintUrl && amount) {
        balances[mintUrl] = Number.parseInt(amount, 10);
      }
    });
  return balances;
}

export function parseMints(
  output: string,
): Array<{ url: string; trusted: boolean }> {
  return output
    .split("\n")
    .map((line) => line.trim())
    .map((line) => {
      const urlMatch = line.match(/https?:\/\/\S+/i);
      if (!urlMatch) return null;
      const trustedMatch = line.match(/trusted:\s*(true|false)/i);
      const trustedValue = trustedMatch?.[1];
      return {
        url: urlMatch[0],
        trusted: trustedMatch ? trustedValue?.toLowerCase() === "true" : false,
      };
    })
    .filter((entry): entry is { url: string; trusted: boolean } =>
      Boolean(entry),
    );
}

export function pickTokenLine(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "";
}

export async function createWalletAdapter() {
  let activeMintUrl: string | null = null;
  let mintUnits: Record<string, "sat" | "msat"> = {};

  const walletAdapter = {
    async getBalances(): Promise<Record<string, number>> {
      const output = await runWalletCommand(["balance"]);
      const balances = parseBalances(output);
      mintUnits = Object.fromEntries(
        Object.keys(balances).map((mintUrl) => [mintUrl, "sat"]),
      );
      if (!activeMintUrl) {
        activeMintUrl = Object.keys(balances)[0] || null;
      }
      return balances;
    },
    getMintUnits(): Record<string, "sat" | "msat"> {
      return mintUnits;
    },
    getActiveMintUrl(): string | null {
      return activeMintUrl;
    },
    async sendToken(mintUrl: string, amount: number): Promise<string> {
      const maxRetries = 3;
      const retryDelayMs = 5000;
      const retryErrorPattern = "Proof already reserved by operation";

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const output = await runWalletCommand([
            "send",
            "cashu",
            String(amount),
            "--mint-url",
            mintUrl,
          ]);
          const token = pickTokenLine(output);
          if (!token) {
            throw new Error("Wallet CLI did not return a token.");
          }
          return token;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);

          const shouldRetry =
            attempt < maxRetries &&
            errorMessage.includes(retryErrorPattern);

          if (shouldRetry) {
            logger.log(
              `sendToken attempt ${attempt + 1} failed with reserved proof error, retrying in ${retryDelayMs / 1000}s...`,
            );
            await new Promise((resolve) =>
              setTimeout(resolve, retryDelayMs),
            );
            continue;
          }

          logger.error("Error in walletAdapter sendToken:", error);
          throw error;
        }
      }
      throw new Error("sendToken failed after max retries");
    },
    async receiveToken(token: string): Promise<{
      success: boolean;
      amount: number;
      unit: "sat" | "msat";
      message?: string;
    }> {
      try {
        await runWalletCommand(["receive", "cashu", token]);
        const decoded = getDecodedToken(token);
        const amount = decoded?.proofs?.reduce(
          (sum, proof) => sum + proof.amount,
          0,
        );
        const unit = decoded?.unit === "msat" ? "msat" : "sat";
        return { success: true, amount: amount ?? 0, unit };
      } catch (error) {
        console.log("Eerro in receive", error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const message = errorMessage.includes("Failed to fetch mint")
          ? errorMessage
          : undefined;
        return { success: false, amount: 0, unit: "sat", message };
      }
    },
    isUsingNip60(): boolean {
      return false;
    },
  };

  try {
    const mintsOutput = await runWalletCommand(["mints", "list"]);
    const mints = parseMints(mintsOutput);
    activeMintUrl =
      mints.find((mint) => mint.trusted)?.url || mints[0]?.url || null;
  } catch (error) {
    logger.error("Failed to read mints from wallet:", error);
  }

  return walletAdapter;
}
