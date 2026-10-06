# Linking pi sessions to request/response logs

When `requestResponseLogging` is enabled, the daemon records every proxied
upstream call as two files that share one id:

- `requests/<id>.json` — method, url, baseUrl, redacted headers, request body
- `responses/<id>.jsonl` — one JSON event per line: `response_start`, `chunk`,
  `end` / `error`

The `id` is minted in `src/daemon/request-response-log-sink.ts` (`makeId()`):
the request's arrival time with `:`/`.` swapped for `-`, plus 8 hex chars, e.g.
`2026-09-30T09-22-35-288Z-60c8e8cf`. The request's `id` and the response's
`requestLogId` are the same string, so **the request and response logs are
paired by filename stem** and never need matching against each other.

Separately, pi records its own transcript per working directory. The two are
written by different processes, so the session has no log id and the logs have
no session id. This document explains the two keys that recover the link
exactly, and how to run the mapper on redtop.

## TL;DR

```bash
# on redtop
bun scripts/link-session-logs.ts <session.jsonl> /home/user/.routstrd/reqRes
```

Every assistant turn prints the response log it produced. The request log is
the same stem under `requests/`.

## Where the data lives

| | redtop (`ssh redtop`) | default |
| --- | --- | --- |
| request/response logs | `/home/user/.routstrd/reqRes` | `~/.routstrd/request-response-logs` |
| log root on disk | `requestResponseLogging.dir` in `~/.routstrd/config.json` | `REQUEST_RESPONSE_LOGS_DIR` (`src/utils/config.ts`) |
| pi sessions | `/home/user/.pi/agent/sessions/--<cwd>--/*.jsonl` | `~/.pi/agent/sessions/…` |
| pi provider config | `/home/user/.pi/agent/models.json` (`providers.routstr`) | `~/.pi/agent/models.json` |

On redtop the log root is set explicitly:

```jsonc
// ~/.routstrd/config.json
"requestResponseLogging": { "enabled": true, "dir": "/home/user/.routstrd/reqRes" }
```

pi reaches the daemon through the `routstr` provider that
`routstrd clients add pi-agent` writes into `models.json`
(`src/integrations/pi.ts`, `configPath: ~/.pi/agent/models.json`). So the
sessions and the logs on redtop are two views of the *same* traffic.

Logs are stored uncompressed on redtop (`requests/*.json`,
`responses/*.jsonl`). Elsewhere they may be brotli-compressed (`.jsonl.br`);
the mapper handles both.

## The join keys

### 1. `responseId` ⇄ response stream id (primary, exact)

Each assistant message in a pi session stores the upstream response id:

```jsonc
// session .jsonl
{ "type": "message",
  "timestamp": "2026-09-30T09:22:36.852Z",
  "message": { "role": "assistant", "provider": "routstr",
               "responseId": "chatcmpl-b5e868d7b747dd8be5a2fbc0b1313507", … } }
```

The response log replays the raw upstream SSE stream inside its `chunk` events,
so the same id appears verbatim:

```jsonc
// responses/<id>.jsonl
{ "requestLogId": "2026-09-30T09-22-35-288Z-60c8e8cf", "type": "chunk",
  "text": "data: {\"id\":\"chatcmpl-b5e868d7b747dd8be5a2fbc0b1313507\", …}\n\n" }
```

The id prefix depends on which upstream provider answered — `chatcmpl-…` for
Venice, `gen-…` for OpenRouter — but it is always present and always identical
to `responseId`. Match on `chunk.text`, never on the raw file: the SSE text is
JSON-escaped in the log, so `grep '"id":"'` misses it.

### 2. request ⇄ response (exact, by id)

`requests/<id>.json` and `responses/<id>.jsonl` share the filename stem
(`id` == `requestLogId`). A response hit therefore yields its request for free.

### 3. trigger timestamp ≈ request timestamp (secondary)

The request log's `timestamp` is when the daemon received the call, which is
the instant pi fired it — within ~10–30 ms of the *triggering* session message
(the user turn or tool result), and within a few ms of the assistant record's
epoch-ms `message.timestamp`. Useful as a sanity check or fallback, but not
needed once key 1 works.

## Running the mapper

The mapper is `scripts/link-session-logs.ts` (bun, no extra deps):

```bash
bun run link-logs -- <session.jsonl> [logsDir] [--all] [--json]
```

- `logsDir` defaults to `$ROUTSTRD_LOG_DIR`, else `~/.routstrd/request-response-logs`.
- `--all` scans every response log instead of only the session's UTC day (use
  when a session spans midnight or logs were rotated).
- `--json` prints a machine-readable table with both the `requests/` and
  `responses/` paths per turn.

On redtop the script must exist in the redtop checkout. Copy it over now (or
`git pull` once the change is pushed):

```bash
scp scripts/link-session-logs.ts \
    redtop:~/projects/routstr_main/routstrd/scripts/
```

`bun` is on `PATH` in an interactive fish session on redtop (`~/.bun/bin`);
from a non-interactive shell, add it explicitly:

```bash
ssh redtop 'export PATH=$HOME/.bun/bin:$PATH; \
  bun ~/projects/routstr_main/routstrd/scripts/link-session-logs.ts \
      ~/.pi/agent/sessions/--home-user-projects-routstr_main-routstr-core--/<session>.jsonl \
      ~/.routstrd/reqRes'
```

To work from the Mac against redtop's logs, either run it there over SSH (as
above) or pull the logs first:

```bash
rsync -a redtop:/home/user/.routstrd/reqRes/ ~/.routstrd/reqRes-redtop/
bun scripts/link-session-logs.ts <session.jsonl> ~/.routstrd/reqRes-redtop
```

### Finding the session for a given directory

pi slugs the message's `cwd` into the session directory name by dropping the
leading `/` and replacing the rest with `-`, wrapped in `--`:

```
/home/user/projects/routstr_main/routstr-core
  -> ~/.pi/agent/sessions/--home-user-projects-routstr_main-routstr-core--/
```

Pick the file you want inside that directory (or `ls -t … | head -1` for the
latest).

## Verified

Against this repo's own history the link is 1:1 and exact:

- `2026-09-30T09-21-41-962Z_01a0f19e…jsonl` → **12/12** assistant turns matched
  (provider: Venice, `chatcmpl-…`).
- `2026-09-15T19-49-27-933Z_01a0a69e…jsonl` → **8/8** (OpenRouter, `gen-…`).
- `2026-08-16T10-51-25-080Z_01a00a32…jsonl` → 51 of 55 turns carry a
  `responseId`; all 51 matched (compressed `.br` logs).
- On redtop, `2026-10-01T07-55-38-825Z_01a0f676…jsonl` → **2/2**.

## Caveats

- **Retries and aborted calls leave orphan logs.** A single assistant turn can
  produce more than one request/response pair (transient `scp`-style failures,
  provider retries), and some logs belong to sessions outside the one you are
  looking at. Drive the join from the session, never assume the counts match.
- **No `responseId` = no exact link.** The key exists in modern pi session
  files (see the `2026-06-*` / `2026-08-*` sessions above). If a session omits
  it, fall back to the trigger-timestamp window.
- **Don't match on the system/developer prompt.** The session stores it as
  `sections` (preamble + project context); the request log stores it as one
  flattened `developer` message. They are not byte-identical.
- **Content can quote an id.** Tool output that happens to contain an id string
  can make a stem look like it matches an unrelated turn. The mapper only reads
  `chunk.text`, which is model output, keeping this rare.
- **Logging may start mid-history.** If `requestResponseLogging` was enabled
  after a session began, earlier turns simply have no logs.
