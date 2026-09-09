# routstrd

Routstr daemon - A CLI tool for managing routstr processes, similar to `cocod` (a Cashu wallet daemon).

## Overview

routstrd is a CLI tool that provides a background daemon for the Routstr protocol. It runs on both [Bun](https://bun.sh) and [Deno](https://deno.com) (v2). It integrates with `cocod` for wallet management and uses the Routstr SDK to handle provider routing and model discovery.

## Routstr for Teams

For team-based routing, see [routstrd-auth](https://github.com/Routstr/routstrd-auth).

## Features

- **Daemon Mode**: Run routstrd as a background HTTP server
- **Wallet Integration**: Works with cocod for Cashu token management
- **Provider Routing**: Automatically discovers and routes requests to available providers
- **Config Management**: Stores configuration in `~/.routstrd/`

## Requirements

The standalone release does not require any runtime to be installed. Installing
from npm or running from source requires either [Bun](https://bun.sh) or
[Deno](https://deno.com) v2 — routstrd supports both.

## Installation

### Step 1: Install

**Standalone binary:**

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

**Global with bun:**
```sh
bun i -g routstrd
```

**Global with deno:**
```sh
deno install -gAf npm:routstrd
```

**OR - From source (bun):**
```sh
git clone https://github.com/routstr/routstrd.git
cd routstrd
bun install
bun link
```

**OR - From source (deno):**
```sh
git clone https://github.com/routstr/routstrd.git
cd routstrd
deno install
deno install -gAf -n routstrd ./src/index.ts
```

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

With specific provider:
```sh
routstrd start --provider https://your-provider.com
```

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

Stop the daemon:
```sh
routstrd stop
```

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

#### Route Request
```
POST /
```

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
  "cocodPath": null,
  "autoRefresh": { "enabled": true }
}
```

`autoRefresh.enabled` (default `true`) controls the daemon's scheduled refresh
job, which re-fetches Nostr events, routstr21 models, and client integrations
every 21 minutes. Set it to `false` (or run
`routstrd clients --disable-automatic-refresh`) to turn the schedule off and
refresh manually with `routstrd clients --manual-refresh`. `autoRefresh.intervalMs`
overrides the 21-minute interval.

### Environment Variables

- `ROUTSTRD_DIR` - Config directory (default: `~/.routstrd`)
- `ROUTSTRD_SOCKET` - Socket path (default: `~/.routstrd/routstrd.sock`)
- `ROUTSTRD_PID` - PID file path (default: `~/.routstrd/routstrd.pid`)

## Development

routstrd runs on both Bun and Deno v2 from the same source tree. Bun is the
development runtime — it runs the test suite and builds the release binaries —
but every command below has a Deno equivalent.

Install dependencies:
```sh
bun install     # or: deno install
```

Run CLI / daemon:
```sh
bun run start           # or: deno task start
```

Type-check:
```sh
bun run lint            # or: deno task check
```

Tests run under Bun (`bun test`). Deno support is covered by a cross-runtime
smoke test that boots the daemon, exercises the SQLite, wallet, and HTTP paths,
and shuts it down cleanly:

```sh
bun scripts/smoke/daemon-boot.ts
deno task smoke
```

Build a standalone executable for the current platform:

```sh
bun run build:binary
./dist/routstrd --version
```

Standalone executables are produced by `bun build --compile` only; there is no
Deno-compiled binary. Deno users install from npm or run from source.

Standalone installations update directly from GitHub Releases with
`routstrd update`. npm installations update through the package manager that
installed them (`bun install -g` or `deno install -gAf`). PM2 is an optional
external dependency used only by `routstrd service`; normal daemon operation
does not require it.

### Runtime compatibility notes

Bun-specific APIs are confined to two seams, so the rest of the code is plain
`node:` builtins that both runtimes implement:

- `src/utils/sqlite.ts` — Bun has `bun:sqlite`, Deno has `node:sqlite`; this
  exposes the `bun:sqlite` shape over whichever is available. (`better-sqlite3`
  is not an option: Deno cannot load it at all.)
- `src/runtime.ts` — runtime detection, entrypoint path, standalone-binary
  detection, and the per-runtime global-install command.

`src/daemon/sdk-storage.ts` builds the Routstr SDK's storage drivers on top of
that shim, because the SDK's own entrypoints are Bun-only or Node-only.

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
ROUTSTRD_API_KEY=<api-key> scripts/smoke/chat-completions.sh <model> [model ...]
```

Set `ROUTSTRD_BASE_URL` to test a daemon at a different address. The script
makes live provider requests that may spend wallet funds, so it is intentionally
not part of `bun test`.

### Publishing a standalone release

1. Set a new `package.json` version and commit it. The release tag must be the
   same version prefixed with `v`, and the tag must not already exist.
2. Push the tag. The release workflow runs lint and tests, builds Linux and
   macOS executables for x64 and arm64, smoke-tests them, and publishes the
   archives with `SHA256SUMS`.
3. Verify all four archives appear in the GitHub Release and validate each
   checksum before announcing it.
4. In disposable environments for each platform, test `--version`, `--help`,
   foreground startup failure, and background `start`, `status`, and `stop`
   without Bun on `PATH`.
5. Test `routstrd service install` and restart behavior with PM2 in a disposable
   environment. Never run release/update lifecycle tests against a production
   daemon. When isolation is needed, use both a separate `ROUTSTRD_DIR` and a
   non-production port in that configuration.

## Project Structure

```
routstrd/
├── src/
│   ├── index.ts       # Entry point with shebang
│   ├── cli.ts         # Commander CLI commands
│   ├── cli-shared.ts  # IPC utilities
│   ├── daemon.ts      # HTTP server daemon
│   └── utils/
│       └── config.ts  # Path configuration
├── package.json
└── tsconfig.json
```

## License

MIT
