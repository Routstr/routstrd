# routstrd CLI Reference

Routstr daemon — a Bun-based CLI tool that runs a background HTTP server for the Routstr protocol. It integrates with `cocod` for Cashu wallet management and routes LLM requests to available providers.

## Quick Start

```sh
routstrd onboard          # Initialize (creates config, sets up cocod)
routstrd start            # Start the daemon
routstrd stop             # Stop the daemon
```

After onboarding, the daemon listens at `http://localhost:8008` and exposes an OpenAI-compatible API.

## Commands

### `routstrd onboard`

Initialize routstrd for the first time:
- Creates `~/.routstrd/` config directory
- Creates `~/.routstrd/config.json` with defaults (port 8008, apikeys mode)
- Installs `cocod` globally via bun if not present
- Runs `cocod init` to set up the wallet
- Starts the daemon and configures integrations

### `routstrd start`

Start the background daemon process.

| Option | Description |
|--------|-------------|
| `--port <port>` | Port to listen on (default: 8008) |
| `-p, --provider <provider>` | Default provider to use |

### `routstrd stop`

Stop the background daemon.

### `routstrd restart`

Restart the daemon (stops if running, then starts).

| Option | Description |
|--------|-------------|
| `--port <port>` | Port to listen on |
| `-p, --provider <provider>` | Default provider to use |

### `routstrd status`

Check daemon and wallet status. Returns JSON with current state.

### `routstrd ping`

Test connection to the daemon.

### `routstrd balance`

Get wallet and API key balances. Shows per-mint wallet balances, per-key API balances, and a grand total (all in sats).

### `routstrd models`

List available routstr21 models (discovered via Nostr).

| Option | Description |
|--------|-------------|
| `-r, --refresh` | Force refresh models from Nostr |

### `routstrd usage`

Show recent usage logs and total sats cost.

| Option | Default | Description |
|--------|---------|-------------|
| `-n, --limit <number>` | 10 | Number of recent entries (max 1000) |

Shows timestamp, model, provider, sats cost, token counts, and request ID for each entry.

### `routstrd providers`

List and manage providers (subcommand required).

#### `routstrd providers list`

List all providers with their enabled/disabled status. Shows index, status, and base URL.

```
Providers (12 total, 2 disabled):

  [0] enabled   https://provider1.example.com
  [1] enabled   https://provider2.example.com
  [2] DISABLED  https://provider3.example.com
```

#### `routstrd providers disable <indices...>`

Disable providers by their index numbers.

```sh
routstrd providers disable 0 2 5
```

#### `routstrd providers enable <indices...>`

Enable providers by their index numbers.

```sh
routstrd providers enable 0 2 5
```

### `routstrd clients`

List and manage API clients (subcommand required).

#### `routstrd clients list`

List all registered clients with their ID, name, API key, and creation date.

#### `routstrd clients add`

Add a new client.

| Option | Description |
|--------|-------------|
| `-n, --name <name>` | **Required.** Client name |

Returns the client ID and API key for use with the OpenAI-compatible API.

### `routstrd mode`

Interactive prompt to set the client mode:
1. **lazyrefund/apikeys** (default) — Pseudonymous accounts kept with Routstr nodes, refunded after 5 mins if unused.
2. **xcashu** (coming soon) — Balances never kept with nodes, all refunded in response.

Changing mode restarts the daemon automatically.

### `routstrd monitor`

Open an interactive TUI (htop-like) for usage monitoring.

### `routstrd logs`

View daemon logs.

| Option | Default | Description |
|--------|---------|-------------|
| `-f, --follow` | false | Follow log output (like `tail -f`) |
| `-n, --lines <number>` | 50 | Number of lines to show |

Log files are stored at `~/.routstrd/logs/YYYY-MM-DD.log`.

## Wallet Commands

### `routstrd wallet status`

Check wallet status.

### `routstrd wallet unlock <passphrase>`

Unlock the wallet with a passphrase.

### `routstrd wallet balance`

Get wallet balance.

### `routstrd wallet receive cashu <token>`

Receive funds via a Cashu token.

### `routstrd wallet receive bolt11 <amount>`

Create a Lightning invoice to receive funds. Displays a QR code.

| Option | Description |
|--------|-------------|
| `--mint-url <url>` | Mint URL to use |

### `routstrd wallet send cashu <amount>`

Create a Cashu token to send.

| Option | Description |
|--------|-------------|
| `--mint-url <url>` | Mint URL to use |

### `routstrd wallet send bolt11 <invoice>`

Pay a Lightning invoice.

| Option | Description |
|--------|-------------|
| `--mint-url <url>` | Mint URL to use |

### `routstrd wallet mints list`

List configured wallet mints.

### `routstrd wallet mints add <url>`

Add a new mint by URL.

### `routstrd wallet mints info <url>`

Get info about a specific mint.

## Daemon API

The daemon exposes an OpenAI-compatible HTTP API at `http://localhost:8008`:

### `GET /health`

Health check endpoint.

### `GET /v1/models`

List available models (OpenAI-compatible).

### `POST /v1/chat/completions`

Route a chat completion request.

```json
{
  "model": "model-id",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": false
}
```

## Configuration

Config file: `~/.routstrd/config.json`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | number | 8008 | Daemon HTTP port |
| `provider` | string\|null | null | Default provider URL |
| `cocodPath` | string\|null | null | Custom path to cocod executable |
| `mode` | string | `"apikeys"` | Client mode (`apikeys` or `xcashu`) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTSTRD_DIR` | `~/.routstrd` | Config directory |
| `ROUTSTRD_SOCKET` | `~/.routstrd/routstrd.sock` | IPC socket path |
| `ROUTSTRD_PID` | `~/.routstrd/routstrd.pid` | PID file path |

## Pi Integration

When `routstrd onboard` runs, it automatically configures a `routstr` provider in `pi`'s `models.json` with an OpenAI-compatible base URL and API key. This allows pi (the AI coding agent) to use Routstr providers seamlessly.

## File Locations

| Path | Description |
|------|-------------|
| `~/.routstrd/config.json` | Configuration |
| `~/.routstrd/routstr.db` | SQLite database |
| `~/.routstrd/routstrd.sock` | IPC socket |
| `~/.routstrd/routstrd.pid` | PID file |
| `~/.routstrd/logs/YYYY-MM-DD.log` | Daily log files |
