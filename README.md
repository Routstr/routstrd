# routstrd

Routstr daemon - A CLI tool for managing routstr processes, similar to `cocod` (a Cashu wallet daemon).

## Overview

routstrd is a Bun-based CLI tool that provides a background daemon for the Routstr protocol. It integrates with `cocod` for wallet management and uses the Routstr SDK to handle provider routing and model discovery.

## Routstr for Teams

For team-based routing, see [routstrd-auth](https://github.com/Routstr/routstrd-auth).

## Features

- **Daemon Mode**: Run routstrd as a background HTTP server
- **Wallet Integration**: Works with cocod for Cashu token management
- **Provider Routing**: Automatically discovers and routes requests to available providers
- **Config Management**: Stores configuration in `~/.routstrd/`

## Requirements

- [Bun](https://bun.sh) runtime

```sh
curl -fsSL https://bun.com/install | bash
```

## Installation

### Step 1: Install

**Global with bun:**
```sh
bun i -g routstrd
```

**OR - From source:**
```sh
git clone https://github.com/routstr/routstrd.git
cd routstrd
bun install
bun link
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
  "cocodPath": null
}
```

### Environment Variables

- `ROUTSTRD_DIR` - Config directory (default: `~/.routstrd`)
- `ROUTSTRD_SOCKET` - Socket path (default: `~/.routstrd/routstrd.sock`)
- `ROUTSTRD_PID` - PID file path (default: `~/.routstrd/routstrd.pid`)

## Development

Install dependencies:
```sh
bun install
```

Run CLI:
```sh
bun run start
```

Run daemon:
```sh
bun run start
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
