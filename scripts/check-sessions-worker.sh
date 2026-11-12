#!/usr/bin/env bash
# Run inside a memory-capped scope; only temporary fixture HOME is read.
set -euo pipefail
cd "$(dirname "$0")/.."
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/.pi/agent/sessions/project"
printf '%s\n' '{"type":"session","id":"fixture","cwd":"/fixture"}' '{"type":"message","message":{"role":"user","content":"Isolated runtime fixture"}}' > "$fixture/.pi/agent/sessions/project/s.jsonl"
bun build src/sessions-worker-smoke.ts --target=bun --outfile=dist/sessions-worker-smoke.js
bun build src/tui/usage/sessions-worker.ts --target=bun --outfile=dist/sessions-worker.ts
bun build --compile src/sessions-worker-smoke.ts src/tui/usage/sessions-worker.ts --outfile=dist/sessions-worker-smoke
for mode in source bundled compiled; do
  echo "Checking $mode worker"
  case "$mode" in
    source) command=(bun src/sessions-worker-smoke.ts) ;;
    bundled) command=(bun dist/sessions-worker-smoke.js) ;;
    compiled) command=(./dist/sessions-worker-smoke) ;;
  esac
  HOME="$fixture" ROUTSTRD_DIR="$fixture/.routstrd" "${command[@]}"
done
test ! -e "$fixture/.routstrd/routstr.db"
