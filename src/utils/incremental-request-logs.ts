import { closeSync, fstatSync, openSync, readdirSync, readSync } from "fs";
import { join } from "path";
import { safeCorrelatedLog, type CorrelatedDiagnostic } from "./request-logs";

interface Cursor {
  identity: string;
  offset: number;
  modified: number;
  changed: number;
  checkpoint: Buffer;
  pending: Buffer;
  skipping: boolean;
}

/** In-memory, sanitized diagnostic index. Historical bytes are streamed once;
 * steady-state polls read only appended bytes. No open descriptors survive a poll.
 * Limits are visible in the output rather than silently dropping history.
 */
export class IncrementalRequestLogs {
  private cursors = new Map<string, Cursor>();
  private index = new Map<string, CorrelatedDiagnostic[]>();
  private entries = 0;
  private truncated = new Set<string>();
  private evicted = false;
  private warnings = new Set<string>();
  private readonly chunkBytes = 64 * 1024;
  constructor(
    private directory: string,
    private limits = { requests: 10000, diagnostics: 50000, perRequest: 200 },
  ) {}

  /** Read volume is exposed for deterministic performance regression tests. */
  poll(activeIds: readonly string[] = []): { bytesRead: number; warnings: string[] } {
    let bytesRead = 0;
    const active = new Set(activeIds);
    let files: string[];
    try {
      files = readdirSync(this.directory).filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
    } catch (error) {
      // A missing directory is normal before the daemon first writes a log.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warnings.add("Diagnostic logs could not be read; retrying on the next poll.");
      return { bytesRead, warnings: this.takeWarnings() };
    }
    const present = new Set(files);
    for (const name of this.cursors.keys()) if (!present.has(name)) this.cursors.delete(name);
    for (const name of files) {
      let fd: number | undefined;
      try {
        fd = openSync(join(this.directory, name), "r");
        const stat = fstatSync(fd);
        if (!stat.isFile()) continue;
        const identity = `${stat.dev}:${stat.ino}`;
        let cursor = this.cursors.get(name);
        let reset = !cursor || cursor.identity !== identity || stat.size < cursor.offset;
        if (!reset && cursor && cursor.checkpoint.length &&
          (stat.size !== cursor.offset || stat.mtimeMs !== cursor.modified || stat.ctimeMs !== cursor.changed)) {
          const checkpoint = Buffer.allocUnsafe(cursor.checkpoint.length);
          const count = readSync(fd, checkpoint, 0, checkpoint.length, cursor.offset - checkpoint.length);
          bytesRead += count;
          reset = count !== checkpoint.length || !checkpoint.equals(cursor.checkpoint);
        }
        if (reset || !cursor) {
          cursor = { identity, offset: 0, modified: stat.mtimeMs, changed: stat.ctimeMs,
            checkpoint: Buffer.alloc(0), pending: Buffer.alloc(0), skipping: false };
          this.cursors.set(name, cursor);
        }
        // Snapshot the end so a busy writer cannot keep this poll running forever.
        const end = stat.size;
        const buffer = Buffer.allocUnsafe(this.chunkBytes);
        while (cursor.offset < end) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, end - cursor.offset), cursor.offset);
          if (!count) break;
          cursor.offset += count;
          bytesRead += count;
          const bytes = buffer.subarray(0, count);
          this.consume(cursor, bytes, active);
          // Save consumed bytes, not a second read: this also anchors partial
          // UTF-8 lines and detects truncate/regrow before reusing their tail.
          cursor.checkpoint = Buffer.from(bytes.length >= 256
            ? bytes.subarray(bytes.length - 256)
            : Buffer.concat([cursor.checkpoint, bytes]).subarray(-256));
        }
        cursor.modified = stat.mtimeMs;
        cursor.changed = stat.ctimeMs;
      } catch {
        this.warnings.add("A diagnostic log changed or could not be read; retrying on the next poll.");
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    return { bytesRead, warnings: this.takeWarnings() };
  }

  diagnostics(ids: readonly string[]): ReadonlyMap<string, readonly CorrelatedDiagnostic[]> {
    return new Map(ids.map(id => {
      const records = this.index.get(id) ?? [];
      const incomplete = this.evicted || this.truncated.has(id);
      return [id, incomplete ? [...records, {
        timestamp: records.at(-1)?.timestamp ?? 0,
        message: "Diagnostic history limited by the follow cache; use --raw for retained file history.",
      }] : records];
    }));
  }

  private takeWarnings(): string[] {
    const warnings = [...this.warnings]; this.warnings.clear(); return warnings;
  }

  private consume(cursor: Cursor, bytes: Buffer, active: Set<string>): void {
    const data = cursor.pending.length ? Buffer.concat([cursor.pending, bytes]) : bytes;
    let start = 0;
    for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
      if (!cursor.skipping && end - start <= this.chunkBytes) this.add(data.subarray(start, end).toString("utf8").replace(/\r$/, ""), active);
      else if (!cursor.skipping) this.warnings.add("An oversized diagnostic line was omitted.");
      cursor.skipping = false;
      start = end + 1;
    }
    const tail = data.subarray(start);
    // Overlong/payload lines are not useful operational labels. Bound partial
    // buffers too, and skip through newline rather than parsing a continuation.
    if (tail.length > this.chunkBytes) {
      cursor.skipping = true;
      cursor.pending = Buffer.alloc(0);
      this.warnings.add("An oversized diagnostic line was omitted.");
    } else cursor.pending = Buffer.from(tail);
  }

  private add(line: string, active: Set<string>): void {
    // Request ids may also occur in payload suffixes: safeCorrelatedLog remains
    // the sole authority for eligibility and strips all variable message text.
    const ids = new Set([...line.matchAll(/\[req:([^\]:\s]+)(?=\]|:)/g)].map(m => m[1]!));
    for (const id of ids) {
      const safe = safeCorrelatedLog(line, id);
      if (!safe) continue;
      // Real lifecycle UUIDs and operational labels are short. Bound bytes as
      // well as entry counts if an unusual file contains attacker-sized tags.
      if (Buffer.byteLength(id) > 256 || Buffer.byteLength(safe.message) > 1024) {
        this.warnings.add("An oversized diagnostic identifier or label was omitted.");
        continue;
      }
      let records = this.index.get(id);
      if (!records) { records = []; this.index.set(id, records); }
      records.push(safe); this.entries++;
      if (records.length > this.limits.perRequest) {
        records.shift(); this.entries--; this.truncated.add(id);
      }
      while (this.index.size > this.limits.requests || this.entries > this.limits.diagnostics) {
        let victim: string | undefined;
        for (const key of this.index.keys()) if (!active.has(key)) { victim = key; break; }
        victim ??= this.index.keys().next().value;
        if (victim === undefined) break;
        this.entries -= this.index.get(victim)!.length;
        this.index.delete(victim); this.truncated.delete(victim); this.evicted = true;
      }
    }
  }
}
