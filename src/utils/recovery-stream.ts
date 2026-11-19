export type RecoveryStreamEvent =
  | { type: "progress"; message: string }
  | { type: "result"; ok: true; message: string }
  | { type: "result"; ok: false; error: string };

export function encodeRecoveryEvent(event: RecoveryStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

function parseRecoveryEvent(line: string): RecoveryStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Daemon returned malformed recovery progress data.");
  }

  if (!value || typeof value !== "object") {
    throw new Error("Daemon returned an invalid recovery event.");
  }

  const event = value as Record<string, unknown>;
  if (event.type === "progress" && typeof event.message === "string") {
    return { type: "progress", message: event.message };
  }
  if (
    event.type === "result" &&
    event.ok === true &&
    typeof event.message === "string"
  ) {
    return { type: "result", ok: true, message: event.message };
  }
  if (
    event.type === "result" &&
    event.ok === false &&
    typeof event.error === "string"
  ) {
    return { type: "result", ok: false, error: event.error };
  }

  throw new Error("Daemon returned an invalid recovery event.");
}

/**
 * Consume a recovery NDJSON response. A terminal result event is mandatory;
 * EOF before that event is treated as a failed/truncated recovery.
 */
export async function consumeRecoveryStream(
  body: ReadableStream<Uint8Array> | null,
  onProgress: (message: string) => void = () => {},
): Promise<string> {
  if (!body) {
    throw new Error("Daemon returned no recovery response body.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: Extract<RecoveryStreamEvent, { type: "result" }> | undefined;

  const consumeLine = (line: string): void => {
    if (!line.trim()) return;
    if (result) {
      throw new Error("Daemon returned data after the recovery result.");
    }
    const event = parseRecoveryEvent(line);
    if (event.type === "progress") {
      onProgress(event.message);
    } else {
      result = event;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }

  buffer += decoder.decode();
  consumeLine(buffer);

  if (!result) {
    throw new Error("Recovery response ended before a result was received.");
  }
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.message;
}
