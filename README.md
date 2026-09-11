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

Build a standalone executable for the current platform:

```sh
bun run build:binary
./dist/routstrd --version
```

Standalone installations update directly from GitHub Releases with
`routstrd update`. npm installations continue to update through Bun. PM2 is an
optional external dependency used only by `routstrd service`; normal daemon
operation does not require it.

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
   macOS executables for x64 and arm64, smoke-tests them, verifies the archives
   through `install.sh` itself, and publishes the archives with `SHA256SUMS` and
   `install.sh`.
3. Verify all four archives and `install.sh` appear in the GitHub Release and
   validate each checksum before announcing it.
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
