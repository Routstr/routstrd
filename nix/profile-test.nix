{
  pkgs,
  package,
}:
pkgs.runCommand "routstrd-profile-test"
  {
    nativeBuildInputs = [
      package
      pkgs.curl
    ];
  }
  ''
    export HOME="$TMPDIR/home"
    export ROUTSTRD_DIR="$HOME/.routstrd"
    export ROUTSTRD_WALLET_DIR="$ROUTSTRD_DIR/wallet"
    export ROUTSTRD_CONFIG_FILE="$TMPDIR/managed.json"
    mkdir -p "$ROUTSTRD_DIR"

    cat >"$ROUTSTRD_CONFIG_FILE" <<'EOF'
    {
      "host": "127.0.0.1",
      "port": 18808,
      "wallet": {
        "initializeDefaultMint": false,
        "enableNpc": false
      }
    }
    EOF

    routstrd --version
    test -x "$(command -v routstrd-pm2)"
    test -f ${package}/share/routstrd/dist/daemon/index.js
    test -f ${package}/share/routstrd/dist/daemon/runtime.js
    routstrd daemon >"$TMPDIR/daemon.log" 2>&1 &
    daemon_pid=$!
    trap 'kill "$daemon_pid" 2>/dev/null || true' EXIT

    healthy=0
    for _ in $(seq 1 120); do
      if curl --fail --silent http://127.0.0.1:18808/health >/dev/null; then
        healthy=1
        break
      fi
      if ! kill -0 "$daemon_pid" 2>/dev/null; then
        cat "$TMPDIR/daemon.log"
        exit 1
      fi
      sleep 0.25
    done
    if [[ "$healthy" -ne 1 ]]; then
      cat "$TMPDIR/daemon.log"
      exit 1
    fi

    test "$(routstrd wallet backup --wallet-dir "$ROUTSTRD_WALLET_DIR" | wc -w)" -eq 12
    routstrd stop
    wait "$daemon_pid"
    trap - EXIT
    touch "$out"
  ''
