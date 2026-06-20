import { createWriteStream, mkdirSync, type WriteStream } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import type { SdkLogger } from "@routstr/sdk";

export interface RequestResponseLogRequestInput {
  method: string;
  url: string;
  path: string;
  baseUrl: string;
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

export interface RequestResponseLogSink {
  logRequest?(input: RequestResponseLogRequestInput): string | undefined | Promise<string | undefined>;
  logResponseStart?(id: string | undefined, response: Response): void | Promise<void>;
  logResponseChunk?(id: string | undefined, sequence: number, text: string): void | Promise<void>;
  logResponseEnd?(id: string | undefined): void | Promise<void>;
  logResponseError?(id: string | undefined, error: unknown): void | Promise<void>;
  logResponseBody?(id: string | undefined, response: Response): void | Promise<void>;
}

interface ActiveResponseLog {
  stream: WriteStream;
  pending: Promise<void>;
}

export interface FileRequestResponseLogSinkOptions {
  dir: string;
  logger?: SdkLogger;
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "x-cashu",
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

const SENSITIVE_BODY_FIELD_NAMES = new Set([
  "authorization",
  "api_key",
  "apikey",
  "apiKey",
  "access_token",
  "accessToken",
  "bearer",
  "cashu",
  "cookie",
  "key",
  "password",
  "secret",
  "token",
  "x-cashu",
]);

const REDACTED = "[REDACTED]";

const sanitizeForFilename = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

const makeId = (): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random = crypto.randomUUID().slice(0, 8);
  return `${timestamp}-${random}`;
};

const headersToObject = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

const redactHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) ? REDACTED : value,
    ]),
  );

const redactBody = (value: unknown): unknown => {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactBody);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_BODY_FIELD_NAMES.has(key) || SENSITIVE_BODY_FIELD_NAMES.has(key.toLowerCase())
        ? REDACTED
        : redactBody(entry),
    ]),
  );
};

const redactRawBody = (rawBody: string | undefined): string | undefined => {
  if (!rawBody) return undefined;
  try {
    return JSON.stringify(redactBody(JSON.parse(rawBody)));
  } catch {
    return rawBody;
  }
};

export class FileRequestResponseLogSink implements RequestResponseLogSink {
  private requestsDir: string;
  private responsesDir: string;
  private activeResponses = new Map<string, ActiveResponseLog>();

  constructor(private options: FileRequestResponseLogSinkOptions) {
    this.requestsDir = join(options.dir, "requests");
    this.responsesDir = join(options.dir, "responses");
    mkdirSync(this.requestsDir, { recursive: true });
    mkdirSync(this.responsesDir, { recursive: true });
  }

  async logRequest(input: RequestResponseLogRequestInput): Promise<string | undefined> {
    try {
      const id = makeId();
      const filePath = join(this.requestsDir, `${sanitizeForFilename(id)}.json`);
      await writeFile(
        filePath,
        JSON.stringify(
          {
            id,
            timestamp: new Date().toISOString(),
            method: input.method,
            url: input.url,
            path: input.path,
            baseUrl: input.baseUrl,
            headers: redactHeaders(input.headers),
            body: redactBody(input.body),
            rawBody: redactRawBody(input.rawBody),
          },
          null,
          2,
        ),
      );
      return id;
    } catch (error) {
      this.options.logger?.error?.("[request-response-log] failed to log request:", error);
      return undefined;
    }
  }

  async logResponseStart(id: string | undefined, response: Response): Promise<void> {
    if (!id) return;
    await this.append(id, {
      type: "response_start",
      status: response.status,
      statusText: response.statusText,
      headers: redactHeaders(headersToObject(response.headers)),
    });
  }

  logResponseChunk(id: string | undefined, sequence: number, text: string): void {
    if (!id) return;
    void this.append(id, {
      type: "chunk",
      sequence,
      text,
    });
  }

  async logResponseEnd(id: string | undefined): Promise<void> {
    if (!id) return;
    await this.append(id, { type: "end" });
    await this.close(id);
  }

  async logResponseError(id: string | undefined, error: unknown): Promise<void> {
    if (!id) return;
    await this.append(id, {
      type: "error",
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    });
    await this.close(id);
  }

  async logResponseBody(id: string | undefined, response: Response): Promise<void> {
    if (!id) return;
    try {
      if (!response.body) {
        await this.logResponseEnd(id);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let sequence = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await this.append(id, {
            type: "chunk",
            sequence: sequence++,
            text: decoder.decode(value, { stream: true }),
          });
        }
      }

      const tail = decoder.decode();
      if (tail) {
        await this.append(id, {
          type: "chunk",
          sequence: sequence++,
          text: tail,
        });
      }

      await this.logResponseEnd(id);
    } catch (error) {
      await this.logResponseError(id, error);
    }
  }

  private getOrCreate(id: string): ActiveResponseLog {
    const existing = this.activeResponses.get(id);
    if (existing) return existing;

    const filePath = join(this.responsesDir, `${sanitizeForFilename(id)}.jsonl`);
    const stream = createWriteStream(filePath, { flags: "a" });
    const active: ActiveResponseLog = {
      stream,
      pending: Promise.resolve(),
    };

    stream.on("error", (error) => {
      this.options.logger?.error?.("[request-response-log] response log stream error:", error);
    });

    this.activeResponses.set(id, active);
    return active;
  }

  private async append(id: string, event: Record<string, unknown>): Promise<void> {
    try {
      const active = this.getOrCreate(id);
      const line = JSON.stringify({ requestLogId: id, timestamp: new Date().toISOString(), ...event }) + "\n";
      active.pending = active.pending.then(
        () =>
          new Promise<void>((resolve, reject) => {
            active.stream.write(line, (error) => {
              if (error) reject(error);
              else resolve();
            });
          }),
      );
      await active.pending;
    } catch (error) {
      this.options.logger?.error?.("[request-response-log] failed to append response event:", error);
    }
  }

  private async close(id: string): Promise<void> {
    const active = this.activeResponses.get(id);
    if (!active) return;
    this.activeResponses.delete(id);
    await active.pending;
    await new Promise<void>((resolve) => active.stream.end(resolve));
  }
}
