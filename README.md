# routstrd

Routstr daemon - A CLI tool for managing routstr processes, with a built-in Cashu wallet.

## Overview

routstrd is a Bun-based CLI tool that provides a background daemon for the Routstr protocol. It carries an in-process Cashu wallet (coco) for payments and uses the Routstr SDK to handle provider routing and model discovery.

## Routstr for Teams

For team-based routing, see [routstrd-auth](https://github.com/Routstr/routstrd-auth).

## Features

- **Daemon Mode**: Run routstrd as a background HTTP server
- **Wallet Integration**: In-process Cashu wallet, with Lightning, NWC, and NPC support
- **Provider Routing**: Automatically discovers and routes requests to available providers
- **Config Management**: Stores configuration in `~/.routstrd/`

## Requirements

The standalone release does not require Bun, Node.js, or npm. Installing from
npm or running from source requires the [Bun](https://bun.sh) runtime.

## Installation

### Step 1: Install

**Standalone binary (recommended):**

Installs the standalone executable for Linux or macOS (x64 or arm64) into
`$HOME/.local/bin`. No Bun, Node.js, or npm required.

```sh
curl -fsSL https://github.com/Routstr/routstrd/releases/latest/download/install.sh | sh
```

Pin a version, change the install directory, or print the resolved asset without
installing anything:

```sh
curl -fsSL https://github.com/Routstr/routstrd/releases/latest/download/install.sh \
  | sh -s -- --version 0.4.9 --dir /usr/local/bin
```

The installer downloads the release archive, verifies it against the release
`SHA256SUMS`, and only replaces an existing `routstrd` once the checksum matches
and the extracted binary reports the expected version.

<details>
<summary>Manual install</summary>

Download the archive for your operating system and architecture from the
[latest GitHub Release](https://github.com/Routstr/routstrd/releases/latest).
Release archives are available for Linux and macOS on x64 and arm64.

```sh
grep "routstrd-v0.4.9-linux-x64.tar.gz" SHA256SUMS | shasum -a 256 -c -
tar -xzf routstrd-v0.4.9-linux-x64.tar.gz
mkdir -p "$HOME/.local/bin"
install -m 755 routstrd "$HOME/.local/bin/routstrd"
```

Substitute the version, platform, and architecture for the archive you
downloaded, and ensure `$HOME/.local/bin` is on `PATH`.

</details>

Installing the standalone binary is preferred over the npm package: the npm
package runs through the Bun runtime, while the standalone executable has no
runtime dependency.

**Global with bun:**
```sh
bun i -g routstrd
```

**OR - From source:**
```sh
git clone https://github.com/routstr/routstrd.git
cd routstrd
bun install
bun run build   # `bun link` installs dist/index.js, so it must exist first
bun link
```

`bun link` puts `routstrd` in `$BUN_INSTALL/bin` (by default `~/.bun/bin`), which
must be on your `PATH`.

### Step 2: Setup & Fund

```sh
routstrd onboard
routstrd receive <cashu>       # receive a Cashu token
routstrd receive 2100         # to top up 2100 sats with lightning
```

### Step 3: Integrate with Claude Code

```sh
routstrd clients add --claude-code  # or --pi-agent / --opencode
```

## Use Routstrd Skill

> **Tip:** You can also install the [routstrd skill](https://github.com/Routstr/routstrd/blob/main/SKILL.md) so the agent can manage routstrd for you.

## More Commands

[`SKILL.md`](SKILL.md) is the complete per-command reference — every command,
subcommand, and flag. The sections below cover the common ones.
### Start Daemon

Start the background daemon:

```sh
routstrd start
```

With custom port:
```sh
routstrd start --port 9000
```

The daemon binds to `127.0.0.1` by default. To expose it on another interface:
```sh
routstrd start --host 0.0.0.0
```

Only expose the daemon behind appropriate network controls.

Pin all requests to one provider (no cross-provider failover):
```sh
routstrd start --provider https://your-provider.com
```
See [Provider pinning](#provider-pinning) for the request-level header/query.

### CLI Commands

Check daemon status:
```sh
routstrd status
```

Get wallet balance:
```sh
routstrd balance
```

Test connection:
```sh
routstrd ping
```

Refresh models and client integrations on demand:
```sh
routstrd clients --manual-refresh   # same as `routstrd refresh`
```

Turn the daemon's scheduled refresh on or off (no restart needed):
```sh
routstrd clients --disable-automatic-refresh
routstrd clients --enable-automatic-refresh
```

Show or toggle automatic model-path selection (applied to the running daemon
immediately — no restart):
```sh
routstrd models auto-model-path          # show the current setting
routstrd models auto-model-path on
routstrd models auto-model-path off
routstrd models auto-model-path toggle
```

Stop the daemon:
```sh
routstrd stop
```

See which providers/models the router is currently skipping (cooldowns):
```sh
routstrd cooldowns
routstrd cooldowns --json
```

Clear all active cooldowns and failure strikes so every provider is retried now:
```sh
routstrd cooldowns --reset
```

### Offline Cashu sends

Use `--offline` to create a token directly from existing proofs, without a
swap or change outputs. Routstrd picks the closest available proof set whose
total covers the request, so the token can be worth slightly more than asked:

```sh
routstrd send 1020 --offline
# or: routstrd wallet send cashu 1020 --offline
```

The response includes the token, its `operationId`, and the requested/actual
amounts. Selected proofs are marked `inflight`; offline operations do not
subscribe to the mint for settlement. After the recipient claims the token,
mark it spent and finalize the operation locally:

```sh
routstrd wallet send mark-spent <operation-id>
```

`mark-spent` prompts for confirmation (`--yes` bypasses it for automation).
It is an irreversible local assertion and does not verify claim status with the
mint: those proofs will not be checked again even if the recipient never claims
them. As a mint-verified alternative, `wallet check-proofs` checks inflight
proofs and can automatically finalize offline sends whose proofs are spent.

`wallet cleanup` never reclaims offline sends. Use the explicitly confirmed
`wallet sweep-offline` below instead; age alone does not mean a token was abandoned.
Normal sends without `--offline` retain Coco's swap and automatic
proof-state behavior.

#### Bounding the overpayment

Because a no-swap send hands over whole proofs, a small request can pick a much
larger proof. Use `--overpay-cap` to allow a token worth at most a multiple of
the requested amount, falling back to an online send when the closest no-swap
token would exceed it:

```sh
# token may be worth at most 3x the request (3000 sats for `send 1000`)
routstrd send 1000 --offline --overpay-cap 3

# the bare flag uses the 3x default
routstrd send 1000 --offline --overpay-cap
```

If the cap is exceeded, routstrd performs a normal online send (swap) instead
and reports `"mode": "online"` with `overpayment: 0`. Only `mode: "offline"`
operations need `mark-spent`; online fallbacks finalize through Coco's normal
proof-state watcher.

### Sweeping old offline sends (explicit operator action)

Offline tokens **do not expire after seven days**. A recipient may hold one
for months. Routstrd never automatically reclaims them during startup.
To inspect pending offline sends aged at least seven days:

```sh
routstrd wallet sweep-offline --dry-run
# Limit to a mint or override the age in hours:
routstrd wallet sweep-offline --mint-url https://mint.example --min-age 336 --dry-run
```

The preview is local only: it lists operation IDs, mints and token face values;
it does not establish whether a recipient claimed a token. Age is measured
from the send operation's creation time, not its last refresh. Only pending
`offline` operations qualify for reclaim; aged `rolling_back` operations are
reported separately as **stuck** even in a dry run. Online, executing and
prepared operations are not swept (a stale prepared send is outside this tool's scope).
For a read-only mint-backed check of ready/inflight proofs across the wallet,
use `routstrd wallet check-proofs --dry-run`; its report is grouped by mint,
not by send operation.

```sh
routstrd wallet sweep-offline
# Non-interactive use requires explicit consent:
routstrd wallet sweep-offline --yes
```

**Reclaiming invalidates the outstanding token, even if the recipient still
holds it.** The command warns and asks `[y/N]`; without a terminal, use `--yes`
or it refuses to apply. Mint connectivity is required and reclaim fees may
reduce the returned value. Amounts in the report are token face values, not net
reclaim proceeds.

For each candidate, the sweep asks the mint about its proofs:

- **Claimed:** every proof is SPENT; persist mint-verified settlement and finalize
  the send. No value is reclaimed.
- **Reclaimed:** every proof is UNSPENT; use Coco's normal mint-backed reclaim to
  swap into fresh local proofs. Shared proofs are never merely restored to ready.
- **Unresolved:** mixed, PENDING or unknown states; leave the token untouched.
- **Failed:** unreachable mint, malformed response, fee-exhausted token, or failed
  reclaim/finalization. Continue to other operations and report the operation ID.
  A recipient can redeem between check and reclaim; that race is reported as a
  failure, never a successful reclaim.
- **Stuck:** an earlier failed/interrupted reclaim left Coco in `rolling_back`.
  The sweep does not retry it or change its proofs. Normal startup recovery only
  warns; neither cleanup, `wallet doctor` (directory diagnostics), nor re-running
  this sweep repairs it. Preserve the wallet database/config and seed backups,
  inspect history, and seek manual recovery via seed restore in a compatible
  Cashu wallet. SPENT inputs alone cannot distinguish recipient redemption from
  our own completed swap whose response was lost; do not reset the operation or
  restore shared proofs to ready.

Mint metadata and proof-state reads have 30-second wait limits per operation;
a failed read leaves the token untouched and the sweep continues. Reclaim swaps
are not timed out or cancelled: an HTTP/CLI timeout does not stop daemon work.
Shutdown waits for tracked sweep work and any late metadata reads before closing
storage (a slow mint can delay completion).

The CLI exits nonzero for failures, unresolved tokens or stuck operations.
Dry runs report candidates and stuck operations, not claimed/reclaimed counts. This is separate from manual
`mark-spent`, which asserts settlement without mint verification.
The daemon API is `POST /wallet/sweep-offline` with optional `mintUrl`,
`minAgeMs` (default 604800000), and `dryRun`; applying requires
`confirmed: true` even for API clients. A supplied `mintUrl` must be a non-empty
HTTP(S) URL, without credentials, query or fragment. An unmatched mint filter
produces a CLI warning; it does not mean that mint has no outstanding tokens.

**Never expose the daemon HTTP port to untrusted clients or the public internet.**
Wallet routes are unauthenticated; a confirmed sweep can invalidate recipients'
tokens. Keep the default loopback binding or protect access outside routstrd.

### NPC (Lightning Address)

The in-process wallet registers the NPC (npubx.cash) plugin, which gives the
daemon a persistent Lightning address backed by the wallet's Cashu mints.
Payments to the address are imported into the wallet automatically (websocket
push, plus manual sync on demand).

```sh
# Show your NPC Lightning address (username@npubx.cash, or npub fallback)
routstrd wallet npc address

# Claim a username (quote first, then confirm to pay the claim fee from the wallet)
routstrd wallet npc username myname
routstrd wallet npc username myname --confirm

# Manually sync paid NPC quotes into the wallet
routstrd wallet npc sync
```

Equivalent daemon endpoints: `GET /wallet/npc/address`,
`POST /wallet/npc/username`, `POST /wallet/npc/sync`.

### Daemon API

The daemon exposes an HTTP server (default port 8008) with the following endpoints:

#### Health Check
```
GET /health
```

#### Version
```
GET /version
```

Returns the running daemon version plus the cached result of its background
update check (`{ version, current, latest, hasUpdate, checkedAt }`). The daemon
refreshes that cache every 6 hours; the TUI banner and the CLI's
"update available" notice both read it. The TUI falls back to direct checks
every 210 minutes only when the daemon does not support this endpoint.

#### Cooldowns
```
GET /cooldowns
POST /cooldowns/reset
```

`GET /cooldowns` lists providers and models the router is currently skipping.
Each entry reports its scope (`provider` blocks every model on that provider,
`model` blocks one), when the cooldown started, and when it lifts. Expired
entries are filtered out, and the cooldown window comes from the SDK
(`cooldownDurationMs`).

`POST /cooldowns/reset` clears every active cooldown (and the failure strikes
that turn the next failure into an instant cooldown) so the router retries all
providers immediately. It returns the number of entries cleared and the
affected providers.

#### Automatic Refresh Settings
```
POST /settings/auto-refresh
```

Request body:
```json
{ "enabled": false }
```

Enables or disables the scheduled refresh job. Persisted to the daemon's
`config.json` as `autoRefresh.enabled` and picked up on the next tick, so no
daemon restart is required.

#### Automatic Model-Path Settings
```
GET /settings/auto-model-path
POST /settings/auto-model-path
```

Request body for `POST`:
```json
{ "enabled": true }
```

Reads or writes `autoModelPath` in the daemon's `config.json`, and applies it to
routing immediately. `enabled` must be a boolean; anything else is a `400`
rather than a silent disable. Both verbs return the live value (`autoModelPath`)
and the value on disk (`configured`): they differ only when `config.json` was
edited by hand, which still needs a restart to take effect. Manage it with
`routstrd models auto-model-path`.

#### Route Request
```
POST /v1/chat/completions
```

Any unmatched `POST` path is proxied to the selected provider with the incoming
path preserved, so `POST /v1/messages` (Anthropic Messages API) and
`POST /v1/responses` (OpenAI Responses API) work in their own formats too.

#### Provider pinning

Pin a request to a single provider with either the `x-routstr-provider` header
or the `?provider=` query parameter (the query takes precedence):

```sh
curl -H 'x-routstr-provider: https://your-provider.com' ... \
  http://127.0.0.1:8008/v1/chat/completions
```

A pin is strict: the request is sent only to that provider. On an upstream
error — including a 400/422 the node itself rejects — the request is **not**
failed over to another node; the error is returned to the client. Retries
against the same provider (top-up, mint fallback) still happen. The config
`provider` and `routstrd start --provider` set the same strict pin as a
default for every request.

Request body:
```json
{
  "model": "model-id",
  "messages": [...],
  "stream": false
}
```

Response:
```json
{
  "choices": [...],
  "usage": {...}
}
```

## Wallet storage

The in-process Cashu wallet stores its mnemonic and proof database in
`~/.routstrd/wallet/`. On first startup, an existing wallet in `~/.cocod/` is
migrated automatically after routstrd verifies that the legacy cocod daemon is
not running. Back up your mnemonic before upgrading.

Set `ROUTSTRD_WALLET_DIR` to override the canonical wallet directory. The
`COCOD_DIR`, `COCOD_SOCKET`, and `COCOD_PID` variables are retained only for
locating and excluding a legacy external cocod process.

If both `~/.routstrd/wallet` and `~/.cocod` contain different wallets, startup
refuses to migrate rather than picking a mnemonic for you. Run
`routstrd wallet doctor` to compare the two wallets (mnemonic fingerprints,
timestamps, and balances) and see which one to keep.

## Configuration

Configuration is stored in `~/.routstrd/config.json`:

```json
{
  "port": 8008,
  "host": "127.0.0.1",
  "provider": null,
  "autoModelPath": false,
  "autoRefresh": { "enabled": true }
}
```

`autoRefresh.enabled` (default `true`) controls the daemon's scheduled refresh
job, which re-fetches Nostr events, routstr21 models, and client integrations
every 21 minutes. Set it to `false` (or run
`routstrd clients --disable-automatic-refresh`) to turn the schedule off and
refresh manually with `routstrd clients --manual-refresh`. `autoRefresh.intervalMs`
overrides the 21-minute interval.

`autoModelPath` defaults to `false`. Set it to `true` to let the SDK automatically
choose and pin an advertised model path for `deepseek-v4.1-flash` requests.
Explicit `x-routstr-model-path` request headers work independently of this
setting and take precedence. Change it with
`routstrd models auto-model-path on|off|toggle`: the daemon applies the new value
to the next routed request, so editing the file by hand is only useful together
with a restart.

`confidentialUpstream` (off by default) lets requests sent with the
`x-routstr-verify: confidential` header run so the node never sees the prompt
or response. See [docs/confidential-upstream.md](docs/confidential-upstream.md).

`provider` pins every request to one node (same strict behavior as the
`x-routstr-provider` header / `?provider=` query). Leave it `null` to let the
router pick the cheapest eligible provider and fail over between nodes.

The OpenCode integration writes the native v2 config shape (`providers` with a
per-provider `package`) and no longer writes the v1 `provider.routstr` block,
which OpenCode v1 does not read. OpenCode picks the transport with that runtime
package, so the integration pins it per model: `claude*` models go to
`{root}/messages` and `gpt-*` models to `{root}/responses` (the same families
the pi integration pins), and every other model uses `{root}/chat/completions`,
the provider default. A `package` you curate by hand on a model outside those
two families survives a refresh, as do the other keys you add to a model entry
(`limit`, `capabilities`, ...).

Reasoning-effort `variants` are derived per model from the daemon's published
`reasoning.supported_efforts` allowlist (the same metadata the pi integration
turns into `thinkingLevelMap`), so `opencode run --model
routstr/glm-5.3#max`, `/models`, and ctrl+t only offer levels the model
actually accepts. Explicit variants are used because `capabilities.reasoning`
is not honoured for a custom provider: OpenCode 2.0.28 collapses it to
`low`/`medium`/`high` for `openai-compatible`, ignores the effort allowlist,
and produces no variants at all for the responses and anthropic-compatible
packages. `none` is omitted on models whose reasoning is mandatory, and the
`messages` package only offers the `low`/`medium`/`high`/`xhigh`/`max` subset
that the Anthropic route accepts. When the daemon publishes no allowlist the
`variants` you curated survive a refresh; when it does, the derived set
replaces them wholesale.

### Environment Variables

- `ROUTSTRD_DIR` - Config directory (default: `~/.routstrd`)
- `ROUTSTRD_SOCKET` - Socket path (default: `~/.routstrd/routstrd.sock`)
- `ROUTSTRD_PID` - PID file path (default: `~/.routstrd/routstrd.pid`)
- `ROUTSTRD_WALLET_DIR` - Wallet data directory (default: `~/.routstrd/wallet`)
- `ROUTSTRD_LOG_LEVEL` - Minimum level written to the daily log: `debug`, `info` (default), `warn` or `error`. See [docs/logging.md](docs/logging.md)
- `ROUTSTRD_COCO_LOG_LEVEL` - Same, for the Cashu wallet-engine log (default: `debug`)
- `COCOD_DIR` - Legacy external cocod directory, used only for migration and exclusion (default: `~/.cocod`)

## Development

Install dependencies:
```sh
bun install
```

Run the CLI from source:
```sh
bun src/index.ts <command>
```

Run the daemon:
```sh
bun run start
```

Run the tests:
```sh
bun test
```

Build a standalone executable for the current platform:

```sh
bun run build:binary
./dist/routstrd --version
```

Standalone installations update directly from GitHub Releases with
`routstrd update`. npm installations continue to update through Bun. PM2 is an
optional external dependency used only by `routstrd service`; normal daemon
operation does not require it.

A background check in the daemon caches whether a newer routstrd exists in
`~/.routstrd/update-state.json` (refreshed every 6 hours) and serves it from
`GET /version`. The usage TUI shows an update banner from that cache, and after
most commands the CLI prints a one-line notice pointing at `routstrd update`.
Automatic checks are enabled by default. To disable background checks, startup
prompts, CLI notices and the TUI banner, add this Boolean to
`~/.routstrd/config.json` (or the config file under `ROUTSTRD_DIR`):

```json
{ "updateCheck": false }
```

Merge this field into your existing config; do not replace the other settings.
The explicit `routstrd update` command remains available. Failed checks preserve
the last successful cache; notices expire after 24 hours and are only shown for
the version currently running.

When an update finds a process on the configured daemon port, it only stops that
process if the wallet PID file confirms a live daemon owned by the same routstrd
configuration. Otherwise the update remains installed, but automatic restart is
refused so an unrelated daemon is not interrupted.

Existing PM2 registrations created by routstrd 0.4.x continue to work through a
compatibility daemon entrypoint. Recreate the registration to use the unified
CLI entrypoint and remove its legacy path dependency:

```sh
routstrd service uninstall
routstrd service install
pm2 save
```

Typecheck:
```sh
bun run lint
```

### Manual chat-completions smoke test

With a funded daemon running, create or reuse a client API key and pass one or
more current model IDs to the smoke script:

```sh
routstrd clients add --name smoke-test
ROUTSTRD_API_KEY=<api-key> bun run smoke <model> [model ...]
```

Set `ROUTSTRD_BASE_URL` to test a daemon at a different address. The script
makes live provider requests that may spend wallet funds, so it is intentionally
not part of `bun test`.

### Publishing a standalone release

1. Set a new `package.json` version and commit it. The release tag must be the
   same version prefixed with `v`, and the tag must not already exist.
2. Push the tag. The release workflow runs lint and tests, builds Linux and
   macOS executables for x64 and arm64, smoke-tests them, verifies the archives
   through `install.sh` itself, and publishes the archives with `SHA256SUMS` and
   `install.sh`. It also publishes `routstrd` to npm via trusted publishing
   (OIDC, no token), skipping gracefully if that version already exists.
3. Verify all four archives and `install.sh` appear in the GitHub Release and
   validate each checksum before announcing it.
4. In disposable environments for each platform, test `--version`, `--help`,
   foreground startup failure, and background `start`, `status`, and `stop`
   without Bun on `PATH`.
5. Test `routstrd service install` and restart behavior with PM2 in a disposable
   environment. Never run release/update lifecycle tests against a production
   daemon. When isolation is needed, use both a separate `ROUTSTRD_DIR` and a
   non-production port in that configuration.

See [docs/CI.md](docs/CI.md) for the full CI/CD details: job layout, npm trusted
publishing (OIDC) setup, the canonical `repository.url` requirement, and how to
order a release when it needs a newer `@routstr/sdk`.

## Project Structure

```
routstrd/
├── src/
│   ├── index.ts        # CLI entry point with shebang
│   ├── cli.ts          # Commander CLI commands
│   ├── daemon.ts       # Compatibility daemon entrypoint (legacy PM2 registrations)
│   ├── start-daemon.ts # Daemon process launcher
│   ├── daemon/         # HTTP server, wallet, provider routing
│   ├── integrations/   # Client integrations (Claude Code, pi, OpenCode, ...)
│   ├── tui/            # Interactive usage monitor (`routstrd monitor`)
│   └── utils/          # Config, paths, daemon client, update checker
├── tests/              # Integration tests (unit tests sit beside their source)
├── scripts/smoke/      # Manual end-to-end smoke test
├── docs/CI.md          # CI and release automation
├── docs/plans/         # Design/migration plans not yet executed
├── package.json
└── tsconfig.json
```

## License

MIT

## Request lifecycle logs

`routstrd logs` shows one persistent summary per inference request, including retries and failures. Use `logs -v` for safe chronological diagnostics, or `logs --raw` for legacy flat logs. See [lifecycle logs and APIs](docs/request-lifecycle-logs.md) for filters, compatibility and SDK prerequisites.
