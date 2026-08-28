#!/usr/bin/env bash

set -euo pipefail

readonly BASE_URL="${ROUTSTRD_BASE_URL:-http://127.0.0.1:8008}"
readonly API_KEY="${ROUTSTRD_API_KEY:-}"

usage() {
  cat <<'EOF'
Usage: ROUTSTRD_API_KEY=<api-key> scripts/smoke/chat-completions.sh <model> [model ...]

Environment:
  ROUTSTRD_API_KEY   Routstrd client API key, without the "Bearer " prefix.
  ROUTSTRD_BASE_URL  Daemon base URL (default: http://127.0.0.1:8008).
EOF
}

if [[ -z "$API_KEY" ]]; then
  echo "error: ROUTSTRD_API_KEY is required" >&2
  usage >&2
  exit 2
fi

if (( $# == 0 )); then
  echo "error: at least one model ID is required" >&2
  usage >&2
  exit 2
fi

for model in "$@"; do
  echo "=== Testing $model ==="

  response="$(
    MODEL="$model" python3 -c '
import json
import os

print(json.dumps({
    "model": os.environ["MODEL"],
    "messages": [
        {"role": "system", "content": "You are Routstr."},
        {"role": "user", "content": "Ping the node"},
    ],
    "max_tokens": 128,
}))
' | curl --silent --show-error --fail-with-body \
      "${BASE_URL%/}/v1/chat/completions" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      --data-binary @-
  )"

  RESPONSE="$response" python3 - <<'PY'
import json
import os
import sys

try:
    payload = json.loads(os.environ["RESPONSE"])
except json.JSONDecodeError as error:
    print(f"error: response was not valid JSON: {error}", file=sys.stderr)
    sys.exit(1)

choices = payload.get("choices")
if not isinstance(choices, list) or not choices:
    print("error: response did not contain a non-empty choices array", file=sys.stderr)
    json.dump(payload, sys.stderr, indent=2)
    print(file=sys.stderr)
    sys.exit(1)

json.dump(payload, sys.stdout, indent=2)
print()
PY

  echo
done
