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

**OR - With Nix:**

```sh
nix run github:Routstr/routstrd -- --help
```

To install the CLI into a user profile on x86-64 or AArch64 Linux:

```sh
nix profile add github:Routstr/routstrd#routstrd
routstrd --version
```

`routstrd start` and `routstrd stop` manage a detached daemon for the current
user. For the app's existing PM2-managed service flow, run:

```sh
routstrd service install
routstrd-pm2 startup
routstrd-pm2 save
```

The installer starts routstrd under PM2 immediately. The namespaced
`routstrd-pm2` command avoids conflicting with a separately installed PM2. The
final two commands configure PM2's existing system startup integration and must
be run separately as instructed by PM2. If `routstrd init` already started a
detached daemon, stop it before installing the PM2 service so only one process
owns the wallet.

The profile owns the installed files, so update this installation through Nix
rather than `routstrd update`:

Detached daemon upgrade:

```sh
routstrd stop
nix profile upgrade routstrd
routstrd start
```

PM2 records immutable Nix store paths, so remove its old process and startup
unit before upgrading, then recreate them from the new profile generation:

```sh
routstrd service uninstall
routstrd-pm2 unstartup
nix profile upgrade routstrd
routstrd service install
routstrd-pm2 startup
routstrd-pm2 save
```

Follow any privileged command printed by PM2 when removing or creating its
system startup integration.

## NixOS

The flake exports `nixosModules.default` and packages for x86_64 and aarch64
Linux. A minimal NixOS configuration is:

```nix
{
  inputs.routstrd.url = "github:Routstr/routstrd";

  outputs = { nixpkgs, routstrd, ... }: {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        routstrd.nixosModules.default
        {
          services.routstrd = {
            enable = true;
            openFirewall = true;
            settings = {
              host = "0.0.0.0";
              port = 8008;
              maxTokens = 64000;
              relays = [ "wss://relay.example.com" ];
            };
          };
        }
      ];
    };
  };
}
```

The module creates a dedicated `routstrd` system account and stores state in
`/var/lib/routstrd`. A wallet is generated automatically on first boot. Back up
its recovery mnemonic with:

```sh
sudo -u routstrd routstrd wallet backup \
  --wallet-dir /var/lib/routstrd/wallet
```

Values in `services.routstrd.settings` are declarative and override mutable
runtime values. Do not put `nsec` or an NWC connection string there because Nix
store paths are world-readable. Put sensitive values in an external JSON file
readable by the service account instead:

```nix
services.routstrd.secretConfigFile = "/run/agenix/routstrd.json";
```

```json
{
  "nsec": "nsec1...",
  "nwc": {
    "mode": "funding_source",
    "connectionString": "nostr+walletconnect://..."
  }
}
```

For offline or isolated startup, disable network-dependent wallet bootstrap:

```nix
services.routstrd.settings.wallet = {
  initializeDefaultMint = false;
  enableNpc = false;
};
```

Build the package, demonstration VM, or explicit NixOS integration test with:

```sh
nix build .#routstrd
nix build .#vm
nix build .#nixos-test
```

The NixOS integration test is intentionally not part of `nix flake check`
because software QEMU can be slow on hosts without KVM acceleration.

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
- `ROUTSTRD_CONFIG_FILE` - Read-only managed JSON configuration
- `ROUTSTRD_SECRET_CONFIG_FILE` - External secret JSON configuration loaded last

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
