# Logging

The daemon appends to dated files under `~/.routstrd/logs/<YYYY-MM-DD>.log`
(one per local day) and to `~/.routstrd/coco-logs/` for Cashu wallet-engine
diagnostics. Writes are synchronous on purpose: the daemon calls
`process.exit()` right after `logger.error(...)` on fatal paths, and async
writes were silently dropped, making startup failures invisible.

## Levels

`ROUTSTRD_LOG_LEVEL` sets the **minimum** level written to disk:

| Value | Written |
| --- | --- |
| `debug` | everything, including per-provider and per-pass diagnostics |
| `info` *(default)* | `info`, `warn`, `error` |
| `warn` | `warn`, `error` |
| `error` | `error` |

An unparseable value falls back to `info` rather than muting the log.

The daemon repeats work on timers, so anything that would otherwise print once
per pass is emitted at `debug` and summarized into a single `info` line. A
scheduled refresh therefore costs **one line** by default:

```
[2026-10-05T15:42:27.044Z] [INFO] Scheduled refresh: 214 models, 3 client integration(s) in 33.4s
```

Set `ROUTSTRD_LOG_LEVEL=debug` to see the phases (`Running scheduled model
refresh...`), the per-provider detail behind a failure summary, and the
Nostr-discovery markers. The daemon inherits the variable from whatever starts
it (`routstrd start`, pm2, systemd), so set it there, not per request.

`coco-logs` is the Cashu wallet-engine sink and writes `debug` regardless of
`ROUTSTRD_LOG_LEVEL`, because those diagnostics are verbose by design (roughly
87% of those lines are `debug`) and live in their own directory precisely so
they stay out of the main log. `ROUTSTRD_COCO_LOG_LEVEL` is its own knob, using
the same values, if you do want it quieter (it is ~19k lines/day on a busy
daemon).

## What a healthy pass looks like

```
$ ROUTSTRD_LOG_LEVEL=info
[INFO] Routstr daemon listening on http://127.0.0.1:8008/v1
[INFO] Initial refresh: 214 models, 3 client integration(s) in 41.2s
[INFO] Model refresh: 32/58 providers ok, 26 unavailable (0 new, 26 unchanged) in 9.8s — maebarai.xyz(530), api.voltai.top(connect), +20 more
[INFO] Scheduled refresh: 214 models, 3 client integration(s) in 33.4s
```

The `Model refresh:` line comes from the SDK (`@routstr/sdk`): it reports
reachability as state *transitions* plus one bounded summary, so a provider that
has been down for days is a count, not a repeated warning. A provider that newly
fails — or starts failing differently — still gets its own `[WARN] Provider
<url> unreachable: ...` line, so anything worth alerting on stays greppable.

## Inspecting

```sh
routstrd logs -n 50          # last 50 lines
routstrd logs -f             # follow (from debug.log, the daemon's stdout)
routstrd logs -c             # Cashu wallet-engine log instead
ROUTSTRD_LOG_LEVEL=debug routstrd start
ROUTSTRD_COCO_LOG_LEVEL=info routstrd start
```
