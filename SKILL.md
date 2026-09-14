# routstrd CLI Reference

Routstr daemon — a Bun-based CLI tool that runs a background HTTP server for the
Routstr protocol. It carries an in-process Cashu wallet (coco) for payments and
routes LLM requests to available providers.

## Quick Start

```sh
routstrd onboard          # Initialize (creates config, sets up the wallet)
routstrd receive 2100     # Top up over Lightning
routstrd start            # Start the daemon
routstrd stop             # Stop the daemon
```

After onboarding, the daemon listens at `http://localhost:8008` and exposes an
OpenAI-compatible API.

## Commands

### `routstrd onboard`

Initialize routstrd for the first time:
- Creates `~/.routstrd/` (mode 0700) and `~/.routstrd/config.json` (mode 0600)
  with defaults (port 8008, host 127.0.0.1, apikeys mode)
- Generates a Nostr identity (`nsec`) for NIP-98 authentication
- Migrates a legacy `~/.cocod` wallet to `~/.routstrd/wallet` if one is present,
  stopping any running external `cocod` first
- Initializes the in-process Cashu wallet
- Starts the daemon and configures a client integration

| Option | Description |
|--------|-------------|
| `--opencode` | Set up OpenCode integration (non-interactive) |
| `--openclaw` | Set up OpenClaw integration (non-interactive) |
| `--pi-agent` | Set up Pi Agent integration (non-interactive) |
| `--claude-code` | Set up Claude Code integration (non-interactive) |
| `--hermes` | Set up Hermes integration (non-interactive) |
| `--skip-integration` | Skip integration setup |

Use at most one integration flag. For several clients, run `routstrd clients add`
afterwards. `--skip-integration` cannot be combined with an integration flag.

### `routstrd start`

Start the background daemon process.

| Option | Description |
|--------|-------------|
| `--port <port>` | Port to listen on (default: 8008) |
| `--host <host>` | Bind address (default: 127.0.0.1) |
| `-p, --provider <provider>` | Default provider to use |

### `routstrd daemon`

Run the daemon in the foreground (same options as `start`). Useful for debugging
and for process supervisors that expect a non-forking process.

### `routstrd stop`

Stop the background daemon.

### `routstrd restart`

Restart the daemon (stops if running, then starts). Same options as `start`.

### `routstrd status`

Check daemon and wallet status. Returns JSON with current state.

### `routstrd ping`

Test connectivity to the daemon.

### `routstrd balance`

Get wallet and API key balances. Shows per-mint wallet balances, per-key API
balances, and a grand total (all in sats).

| Option | Description |
|--------|-------------|
| `--api-keys` | List all stored API keys (baseUrl + key + balance) |
| `--delete-api-keys <baseUrl>` | Delete the API key stored for a provider base URL (refunds its balance first) |
| `--mint-url <url>` | Mint to refund the deleted API key balance to (defaults to the active wallet mint) |

### `routstrd refund`

Refund pending tokens and API keys to a mint.

| Option | Default | Description |
|--------|---------|-------------|
| `-m, --mint-url <mintUrl>` | active wallet mint | Mint URL to refund to |
| `-y, --yes` | false | Skip confirmation prompt |
| `--xcashu` | false | Refund xcashu tokens only |

### `routstrd models`

List available routstr21 models (discovered via Nostr).

| Option | Description |
|--------|-------------|
| `-r, --refresh` | Force refresh models from Nostr |
| `-m, --model <id>` | Show the providers serving a specific model |

### `routstrd usage`

Show recent usage logs and total sats cost.

| Option | Default | Description |
|--------|---------|-------------|
| `-n, --limit <number>` | 10 | Number of recent entries (max 1000) |

Shows timestamp, model, provider, sats cost, token counts, and request ID for
each entry.

### `routstrd history`

Show wallet transaction history.

| Option | Default | Description |
|--------|---------|-------------|
| `-n, --limit <number>` | 50 | Number of entries to show |
| `--offset <number>` | 0 | Number of entries to skip |
| `-v, --verbose` | false | Show full details including encoded Cashu tokens |
| `--json` | false | Output raw JSON with token objects (no encoding) |

### `routstrd providers`

List and manage providers (subcommand required).

#### `routstrd providers list`

List all providers with their enabled/disabled status. Shows index, status, and
base URL.

| Option | Description |
|--------|-------------|
| `--refresh` | Force re-fetch all Nostr events and refresh models from every enabled provider |

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

#### `routstrd providers reviews`

Show all known providers with their stored review events and event IDs.

### `routstrd clients`

List and manage API clients (subcommand required).

| Option | Description |
|--------|-------------|
| `--manual-refresh` | Refresh routstr21 models and all client integrations now |
| `--disable-automatic-refresh` | Disable the daemon's scheduled refresh job |
| `--enable-automatic-refresh` | Re-enable the daemon's scheduled refresh job |

The daemon refreshes models and client integrations on a schedule (every 21
minutes by default). Use `--manual-refresh` to do it on demand, and
`--disable-automatic-refresh` to stop the scheduled job — the setting is stored
in the daemon's `config.json` (`autoRefresh.enabled`) and takes effect without a
restart.

```sh
routstrd clients --manual-refresh              # refresh models + integrations now
routstrd clients --disable-automatic-refresh   # no scheduled refresh
routstrd clients --enable-automatic-refresh    # scheduled refresh back on
```

#### `routstrd clients list`

List all registered clients with their ID, name, API key, and creation date.

#### `routstrd clients add`

Add a new client or set up a client integration.

| Option | Description |
|--------|-------------|
| `-n, --name <name>` | Client name (required when not using integration flags) |
| `--opencode` | Set up OpenCode integration |
| `--openclaw` | Set up OpenClaw integration |
| `--pi-agent` | Set up Pi Agent integration |
| `--claude-code` | Set up Claude Code integration |
| `--hermes` | Set up Hermes integration |

```sh
routstrd clients add --opencode --pi-agent --claude-code  # multiple integrations
routstrd clients add -n "My App"                          # generic client
```

Returns the client ID and API key for use with the OpenAI-compatible API.

#### `routstrd clients delete <id>`

Delete a registered client by its ID.

### `routstrd npubs`

Manage registered npubs and their roles/names (subcommand required). Management
commands route through the auth proxy (`--auth-url`) and use NIP-98 auth.

| Command | Description |
|---------|-------------|
| `routstrd npubs list` | List registered npubs with role and display name |
| `routstrd npubs register [--name <name>]` | Register yourself as the first admin (bootstrap only) |
| `routstrd npubs add <npub> [--role <role>] [--name <name>]` | Add an npub (accepts hex or npub1...); defaults to the `user` role |
| `routstrd npubs update <npub> [--role <role>] [--name <name>]` | Update role and/or name (admin only) |
| `routstrd npubs delete <npub>` | Delete an npub |

### `routstrd remote [url]`

With no URL, print the configured remote daemon. Pass a URL to configure one — a
Nostr identity (nsec/npub) is generated automatically for NIP-98 authentication.

| Option | Description |
|--------|-------------|
| `--auth-url <authUrl>` | URL of the auth proxy used by management commands (`npubs`, `clients`, `usage`) |

```sh
routstrd remote                                  # show current remote
routstrd remote https://your-remote-daemon.com   # configure one
```

### `routstrd local`

Switch back to local daemon mode (clears the configured remote daemon URL).

### `routstrd refresh`

Refresh routstr21 models from Nostr and re-run integrations for all registered
clients. Equivalent to `routstrd clients --manual-refresh`.

### `routstrd update`

Update routstrd to the latest version. Standalone-binary installs update
in place; npm/bun installs are updated through the package manager.

### `routstrd mode`

Interactive prompt to set the client mode:
1. **lazyrefund/apikeys** (default) — Pseudonymous accounts kept with Routstr
   nodes, refunded after 5 mins if unused.
2. **xcashu** (coming soon) — Balances never kept with nodes, all refunded in
   response.

Changing mode restarts the daemon automatically.

### `routstrd monitor` / `routstrd top`

Open an interactive TUI (htop-like) for usage monitoring. `top` is an alias.

### `routstrd logs`

View daemon logs.

| Option | Default | Description |
|--------|---------|-------------|
| `-f, --follow` | false | Follow log output (like `tail -f`) |
| `-c, --coco` | false | Show Cashu wallet-engine (coco) logs instead of daemon logs |
| `-n, --lines <number>` | 50 | Number of lines to show |
| `-r, --recent` | false | List recent request IDs with their model |
| `-i, --request-id <id>` | | Only show log lines for a specific request ID |

Log files are stored at `~/.routstrd/logs/YYYY-MM-DD.log`. Wallet-engine
(Cashu/coco) diagnostics go to a separate `~/.routstrd/coco-logs/YYYY-MM-DD.log`
so they don't pollute the main daemon logs.

### `routstrd service`

Manage routstrd as a system service using PM2, so it survives reboots.

| Command | Description |
|---------|-------------|
| `routstrd service install` | Install and start routstrd under PM2 |
| `routstrd service uninstall` | Stop and remove routstrd from PM2 |
| `routstrd service logs` | View PM2 logs for routstrd |

## Wallet Commands

New wallets automatically trust `https://mint.cubabitcoin.org` as their default
mint. The default is used when a wallet command does not include `--mint-url`.

### `routstrd send <target>` / `routstrd receive <value>`

Shortcuts for the common wallet operations:

| Command | Behaviour |
|---------|-----------|
| `routstrd send 2100` | Numeric target → create a Cashu token for that many sats |
| `routstrd send lnbc1...` | Non-numeric target → pay that Lightning invoice |
| `routstrd receive 2100` | Numeric value → create a Lightning invoice for that many sats and wait for payment |
| `routstrd receive cashuB...` | Non-numeric value → receive that Cashu token |

Both accept `--mint-url <url>`.

### `routstrd wallet status`

Check wallet status.

### `routstrd wallet doctor`

Diagnose conflicting wallets — the current routstrd wallet versus a legacy
`cocod` wallet.

### `routstrd wallet unlock <passphrase>`

Unlock the wallet with a passphrase.

### `routstrd wallet balance`

Get wallet balance.

### `routstrd wallet cleanup`

Clear stuck pending/in-flight wallet operations.

| Option | Default | Description |
|--------|---------|-------------|
| `--mint-url <url>` | all mints | Only clean up operations for this mint URL |
| `--min-age <hours>` | 168 | Minimum age for reclaiming sends and cancelling melts (expired mint quotes are always failed) |
| `--dry-run` | false | Report what would be cleaned without applying changes |
| `-y, --yes` | false | Skip confirmation prompt |

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

### `routstrd wallet mints set-default <url>`

Set the persistent default mint. If necessary, the mint is added as trusted first.

### `routstrd wallet mints info <url>`

Get info about a specific mint.

### `routstrd wallet npc`

NPC (npubx.cash) Lightning address operations.

| Command | Description |
|---------|-------------|
| `routstrd wallet npc address` | Show this wallet's NPC Lightning address |
| `routstrd wallet npc username <name> [--confirm]` | Claim an NPC username; `--confirm` pays the claim fee |
| `routstrd wallet npc sync` | Manually sync paid NPC quotes into the wallet |

## NWC (Nostr Wallet Connect)

Connect an external Lightning wallet and let it fund the Cashu wallet.

| Command | Description |
|---------|-------------|
| `routstrd nwc connect [connection-string]` | Connect via `nostr+walletconnect://...` (prompts if omitted) |
| `routstrd nwc disconnect` | Disconnect from the NWC wallet |
| `routstrd nwc status` | Show connection status and wallet info |
| `routstrd nwc fund <amount>` | Manually fund the Cashu wallet from the connected NWC wallet |

### `routstrd nwc auto-refill on`

Enable automatic wallet refill from NWC.

| Option | Default | Description |
|--------|---------|-------------|
| `--threshold <sats>` | 500 | Refill when the Cashu balance drops below this |
| `--amount <sats>` | 1000 | Refill this many sats at a time |
| `--cooldown <seconds>` | 300 | Minimum time between refills |

### `routstrd nwc auto-refill off`

Disable auto-refill.

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

The incoming request path is forwarded to the provider, so the Anthropic
Messages API (`POST /v1/messages`) and the OpenAI Responses API
(`POST /v1/responses`) are proxied in their own formats as well.

## Configuration

Config file: `~/.routstrd/config.json`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | number | 8008 | Daemon HTTP port |
| `host` | string | `"127.0.0.1"` | Bind address |
| `provider` | string\|null | null | Default provider URL |
| `cocodPath` | string\|null | null | Custom path to a legacy cocod executable |
| `mode` | string | `"apikeys"` | Client mode (`apikeys` or `xcashu`) |
| `maxTokens` | number | 64000 | Completion budget applied when a client sets no output-token limit |
| `daemonUrl` | string | — | Remote daemon URL (set by `routstrd remote`) |
| `authUrl` | string | — | Auth proxy URL for management commands |
| `nsec` | string | — | Nostr secret key for NIP-98 auth |
| `relays` | string[] | — | Nostr relays to use for discovery |
| `routstrPubkey` | string | — | Override the Routstr announcement pubkey |
| `routstrModelsPubkey` | string | — | Override the routstr21 models pubkey |
| `nwc` | object | — | NWC settings (`mode`, `connectionString`, `autoRefill`) |
| `autoRefresh` | object | `{ enabled: true }` | Scheduled refresh job settings (`enabled`, `intervalMs`) |
| `requestResponseLogging` | object | — | Request/response log sink settings |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTSTRD_DIR` | `~/.routstrd` | Config directory |
| `ROUTSTRD_SOCKET` | `~/.routstrd/routstrd.sock` | IPC socket path |
| `ROUTSTRD_PID` | `~/.routstrd/routstrd.pid` | PID file path |
| `ROUTSTRD_WALLET_DIR` | `~/.routstrd/wallet` | In-process Cashu wallet data directory |
| `ROUTSTRD_WALLET_PID` | `<wallet>/wallet.pid` | In-process wallet lock path |
| `COCOD_DIR` | `~/.cocod` | Legacy external cocod compatibility directory |

## Remote Mode

When `daemonUrl` is configured, commands connect to a remote daemon instead of a
local one:
- Client names are suffixed with the last 7 chars of your npub
- All requests are automatically NIP-98 signed using your local nsec
- Local-only commands (`onboard`, `start`, `restart`, `mode`, `logs`, `service`)
  are disabled

Run `routstrd local` to switch back.

## Pi Integration

When `routstrd onboard` runs, it automatically configures a `routstr` provider in
`pi`'s `models.json` with an OpenAI-compatible base URL and API key. This allows
pi (the AI coding agent) to use Routstr providers seamlessly.

## File Locations

| Path | Description |
|------|-------------|
| `~/.routstrd/config.json` | Configuration |
| `~/.routstrd/routstr.db` | SQLite database |
| `~/.routstrd/routstrd.sock` | IPC socket |
| `~/.routstrd/routstrd.pid` | PID file |
| `~/.routstrd/wallet/` | In-process Cashu wallet data (`config.json`, `coco.db`, `wallet.pid`) |
| `~/.routstrd/logs/YYYY-MM-DD.log` | Daily daemon log files |
| `~/.routstrd/coco-logs/YYYY-MM-DD.log` | Daily Cashu wallet-engine (coco) log files |

## Development

```sh
bun install
bun run lint     # tsc --noEmit
bun test
bun run build    # bundles dist/index.js and dist/daemon/index.js
```

End-to-end smoke test against a running daemon (needs a funded client API key):

```sh
ROUTSTRD_API_KEY=<api-key> bun run smoke <model-id> [model-id ...]
```
