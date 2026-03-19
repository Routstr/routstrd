import { Transform } from "stream";
import type { UsageData } from "./types";

export function createSSEParserTransform(
  onUsage: (usage: UsageData) => void,
  onResponseId?: (responseId: string) => void,
): Transform {
  let buffer = "";

  const maybeCaptureUsageFromJson = (jsonText: string): void => {
    try {
      const data = JSON.parse(jsonText) as any;
      const responseId = data.id;
      if (typeof responseId === "string" && responseId.trim().length > 0) {
        onResponseId?.(responseId.trim());
      }

      if (data.usage) {
        const usageCost = data.usage.cost;
        const cost =
          typeof usageCost === "number"
            ? usageCost
            : usageCost?.total_usd ??
              data.metadata?.routstr?.cost?.total_usd ??
              0;
        const msats =
          data.metadata?.routstr?.cost?.total_msats ??
          (typeof data.usage.cost_sats === "number"
            ? data.usage.cost_sats * 1000
            : 0);
        onUsage({
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
          cost,
          satsCost: msats / 1000,
        });
      }
    } catch {
      // Ignore non-JSON lines/events.
    }
  };

  const processLine = (self: Transform, line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    if (trimmed === "data: [DONE]" || trimmed === "[DONE]") {
      self.push("data: [DONE]\n\n");
      return;
    }

    if (trimmed.startsWith("data:")) {
      const dataStr = trimmed.startsWith("data: ")
        ? trimmed.slice(6)
        : trimmed.slice(5).trimStart();
      if (dataStr === "[DONE]") {
        self.push("data: [DONE]\n\n");
        return;
      }
      maybeCaptureUsageFromJson(dataStr);
      self.push(`data: ${dataStr}\n\n`);
      return;
    }

    if (trimmed.startsWith("{")) {
      maybeCaptureUsageFromJson(trimmed);
      self.push(`data: ${trimmed}\n\n`);
      return;
    }

    self.push(line + "\n");
  };

  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString();

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        processLine(this, line);
      }

      callback();
    },
    flush(callback) {
      if (buffer.trim()) {
        processLine(this, buffer);
      }
      buffer = "";
      callback();
    },
  });
}
