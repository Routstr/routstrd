# routstrd

Routstr daemon - A CLI tool for managing routstr processes, similar to `cocod` (a Cashu wallet daemon).

## Overview

routstrd is a Bun-based CLI tool that provides a background daemon for the Routstr protocol. It integrates with `cocod` for wallet management and uses the Routstr SDK to handle provider routing and model discovery.

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

### Install (global with bun)

```sh
bun i -g routstrd
routstrd onboard
```

### From Source

```sh
git clone https://github.com/routstr/routstrd.git
cd routstrd
bun install
bun link
routstrd onboard
```

## Usage

### Initialize

Initialize routstrd (creates config directory and sets up cocod):

```sh
routstrd onboard
```

This will:
- Create `~/.routstrd/` directory
- Create config file at `~/.routstrd/config.json`
- Run `cocod init` to set up the wallet


Then fund with Cashu/Lightning:
```sh
routstrd receive 2100 # to top up 2100 sats with lightning
```
or
```sh
cocod receive cashu <token>
```
or
```sh
cocod receive bolt11 <amount>
```

### That's it! You can start using it on http://localhost:8008

## More Commands
###Start Daemon

Start the background daemon:

```sh
routstrd start
```

With custom port:
```sh
routstrd start --port 9000
```

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

## Configuration

Configuration is stored in `~/.routstrd/config.json`:

```json
{
  "port": 8008,
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
