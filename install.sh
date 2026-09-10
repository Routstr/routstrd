#!/bin/sh
# routstrd installer for standalone releases.
#
#   curl -fsSL https://github.com/Routstr/routstrd/releases/latest/download/install.sh | sh
#
# Downloads the standalone archive for this platform from the GitHub Release,
# verifies it against the release SHA256SUMS, and installs the `routstrd`
# executable. Needs only `sh`, `tar`, `curl` (or `wget`) and a SHA256 tool --
# not Bun, Node.js, or npm.
#
# Options (also available as ROUTSTRD_* environment variables): run this file
# with --help, or see the usage text below, for the full list.

set -eu

REPO="${ROUTSTRD_REPO:-Routstr/routstrd}"
API_BASE_URL="${ROUTSTRD_API_BASE_URL:-https://api.github.com}"
EXPLICIT_DOWNLOAD_BASE_URL="${ROUTSTRD_DOWNLOAD_BASE_URL:-}"
VERSION="${ROUTSTRD_VERSION:-}"
PLATFORM="${ROUTSTRD_PLATFORM:-}"
ARCH="${ROUTSTRD_ARCH:-}"
INSTALL_DIR="${ROUTSTRD_INSTALL_DIR:-}"
PRINT_ASSET=0
PLATFORM_DETECTED=0
ARCH_DETECTED=0
MAX_ARCHIVE_BYTES=262144000
MAX_CHECKSUMS_BYTES=1048576
CONNECT_TIMEOUT_SECS=10
API_TIMEOUT_SECS=60
DOWNLOAD_TIMEOUT_SECS=900

say() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Install routstrd from a standalone GitHub Release.

Usage: sh install.sh [options]

Options:
  --version <version>        Install a specific version (default: latest)
  --dir <path>               Install directory (default: $HOME/.local/bin)
  --install-dir <path>       Alias for --dir
  --platform <platform>      Override platform detection (linux|darwin)
  --arch <arch>              Override architecture detection (x64|arm64)
  --repo <owner/name>        GitHub repository (default: Routstr/routstrd)
  --api-base-url <url>       GitHub API base URL (testing/mirrors)
  --download-base-url <url>  Release download base URL (testing/mirrors)
  --print-asset              Print the resolved asset name and exit
  --help                     Show this help

Environment: ROUTSTRD_VERSION, ROUTSTRD_INSTALL_DIR, ROUTSTRD_PLATFORM,
  ROUTSTRD_ARCH, ROUTSTRD_REPO, ROUTSTRD_API_BASE_URL,
  ROUTSTRD_DOWNLOAD_BASE_URL, GITHUB_TOKEN (for API rate limits)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version requires a value"; VERSION="$2"; shift 2 ;;
    --dir|--install-dir) [ $# -ge 2 ] || die "$1 requires a value"; INSTALL_DIR="$2"; shift 2 ;;
    --platform) [ $# -ge 2 ] || die "--platform requires a value"; PLATFORM="$2"; shift 2 ;;
    --arch) [ $# -ge 2 ] || die "--arch requires a value"; ARCH="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || die "--repo requires a value"; REPO="$2"; shift 2 ;;
    --api-base-url) [ $# -ge 2 ] || die "--api-base-url requires a value"; API_BASE_URL="$2"; shift 2 ;;
    --download-base-url) [ $# -ge 2 ] || die "--download-base-url requires a value"; EXPLICIT_DOWNLOAD_BASE_URL="$2"; shift 2 ;;
    --print-asset) PRINT_ASSET=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown option '$1' (try --help)" ;;
  esac
done

if [ -n "$EXPLICIT_DOWNLOAD_BASE_URL" ]; then
  DOWNLOAD_BASE_URL="$EXPLICIT_DOWNLOAD_BASE_URL"
else
  DOWNLOAD_BASE_URL="https://github.com/${REPO}/releases/download"
fi

if [ -z "$PLATFORM" ]; then
  case "$(uname -s)" in
    Linux) PLATFORM=linux ;;
    Darwin) PLATFORM=darwin ;;
    *) die "unsupported operating system '$(uname -s)'; releases cover Linux and macOS." ;;
  esac
  PLATFORM_DETECTED=1
fi

if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    x86_64|amd64)
      ARCH=x64
      # Under Rosetta, uname reports x86_64 on arm64 Macs; prefer the native build.
      if [ "$PLATFORM" = darwin ] \
        && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
        ARCH=arm64
      fi
      ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "unsupported architecture '$(uname -m)'; releases cover x64 and arm64." ;;
  esac
  ARCH_DETECTED=1
fi

case "$PLATFORM" in
  linux|darwin) ;;
  *) die "unsupported platform '$PLATFORM'; expected linux or darwin." ;;
esac

case "$ARCH" in
  x64|arm64) ;;
  *) die "unsupported architecture '$ARCH'; expected x64 or arm64." ;;
esac

# Resolved lazily by require_http_client, so --print-asset does not need either.
HTTP_CLIENT=""
require_http_client() {
  if [ -n "$HTTP_CLIENT" ]; then
    return 0
  fi
  if command -v curl >/dev/null 2>&1; then
    HTTP_CLIENT=curl
  elif command -v wget >/dev/null 2>&1; then
    HTTP_CLIENT=wget
  else
    die "curl or wget is required to download routstrd."
  fi
}

fetch_stdout() {
  require_http_client
  if [ "$HTTP_CLIENT" = curl ]; then
    curl -fsSL --connect-timeout "$CONNECT_TIMEOUT_SECS" \
      --max-time "$API_TIMEOUT_SECS" --retry 3 \
      -H "Accept: application/vnd.github+json" \
      ${GITHUB_TOKEN:+-H "Authorization: Bearer ${GITHUB_TOKEN}"} "$1"
  else
    wget -qO- --timeout="$API_TIMEOUT_SECS" --tries=3 \
      --header="Accept: application/vnd.github+json" \
      ${GITHUB_TOKEN:+--header="Authorization: Bearer ${GITHUB_TOKEN}"} "$1"
  fi
}

fetch_file() {
  require_http_client
  if [ "$HTTP_CLIENT" = curl ]; then
    curl -fsSL --connect-timeout "$CONNECT_TIMEOUT_SECS" \
      --max-time "$DOWNLOAD_TIMEOUT_SECS" --retry 3 \
      -o "$2" "$1"
  else
    wget -qO "$2" --timeout="$DOWNLOAD_TIMEOUT_SECS" --tries=3 "$1"
  fi
}

if [ -z "$VERSION" ]; then
  if ! release_json="$(fetch_stdout "${API_BASE_URL}/repos/${REPO}/releases/latest")"; then
    die "could not query ${API_BASE_URL}/repos/${REPO}/releases/latest."
  fi
  tag="$(printf '%s\n' "$release_json" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)"
  [ -n "$tag" ] || die "could not read the latest release tag from ${REPO}."
  VERSION="${tag#v}"
else
  VERSION="${VERSION#v}"
fi

case "$VERSION" in
  [0-9]*) ;;
  *) die "invalid version '$VERSION'." ;;
esac
case "$VERSION" in
  *[!0-9A-Za-z.+-]*) die "invalid version '$VERSION'." ;;
esac

ASSET="routstrd-v${VERSION}-${PLATFORM}-${ARCH}.tar.gz"

if [ "$PRINT_ASSET" = 1 ]; then
  printf '%s\n' "$ASSET"
  exit 0
fi

if [ -z "$INSTALL_DIR" ]; then
  [ -n "${HOME:-}" ] || die "HOME is not set; pass --dir or set ROUTSTRD_INSTALL_DIR."
  INSTALL_DIR="$HOME/.local/bin"
fi

if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD="shasum -a 256"
elif command -v openssl >/dev/null 2>&1; then
  SHA256_CMD="openssl_sha256"
else
  die "no SHA256 tool found (need sha256sum, shasum, or openssl)."
fi

hash_file() {
  if [ "$SHA256_CMD" = openssl_sha256 ]; then
    openssl dgst -sha256 -r "$1" | awk '{print $1}' | tr '[:upper:]' '[:lower:]'
  else
    # shellcheck disable=SC2086
    $SHA256_CMD "$1" | awk '{print $1}' | tr '[:upper:]' '[:lower:]'
  fi
}

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/routstrd-install.XXXXXX")" \
  || die "could not create a temporary directory."
STAGED=""
cleanup() {
  if [ -n "$STAGED" ]; then rm -f "$STAGED" 2>/dev/null || true; fi
  if [ -n "$WORKDIR" ]; then rm -rf "$WORKDIR" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'say "Interrupted."; exit 1' INT TERM

RELEASE_BASE_URL="${DOWNLOAD_BASE_URL}/v${VERSION}"
ARCHIVE="${WORKDIR}/${ASSET}"
CHECKSUMS="${WORKDIR}/SHA256SUMS"

say "Installing routstrd v${VERSION} (${PLATFORM}-${ARCH})."

if ! fetch_file "${RELEASE_BASE_URL}/${ASSET}" "$ARCHIVE"; then
  die "could not download ${ASSET} from ${RELEASE_BASE_URL}. Release v${VERSION} may not include a build for ${PLATFORM}-${ARCH}."
fi
if ! fetch_file "${RELEASE_BASE_URL}/SHA256SUMS" "$CHECKSUMS"; then
  die "could not download SHA256SUMS from ${RELEASE_BASE_URL}."
fi

archive_bytes="$(wc -c < "$ARCHIVE" | tr -d '[:space:]')"
[ "$archive_bytes" -le "$MAX_ARCHIVE_BYTES" ] \
  || die "${ASSET} is unexpectedly large (${archive_bytes} bytes)."

checksums_bytes="$(wc -c < "$CHECKSUMS" | tr -d '[:space:]')"
[ "$checksums_bytes" -le "$MAX_CHECKSUMS_BYTES" ] \
  || die "SHA256SUMS is unexpectedly large (${checksums_bytes} bytes)."

expected="$(grep -F "$ASSET" "$CHECKSUMS" 2>/dev/null \
  | awk -v name="$ASSET" '$2 == name || $2 == "*" name { print $1 }' \
  | head -n 1 \
  | tr '[:upper:]' '[:lower:]')"
[ -n "$expected" ] || die "SHA256SUMS does not contain ${ASSET}."

actual="$(hash_file "$ARCHIVE")"
if [ "$actual" != "$expected" ]; then
  die "checksum mismatch for ${ASSET}: expected ${expected}, got ${actual}."
fi

tar -xzf "$ARCHIVE" -C "$WORKDIR" || die "could not extract ${ASSET}."
[ -f "${WORKDIR}/routstrd" ] || die "${ASSET} does not contain a routstrd executable."

mkdir -p "$INSTALL_DIR" || die "could not create ${INSTALL_DIR}."
TARGET="${INSTALL_DIR}/routstrd"
STAGED="${INSTALL_DIR}/.routstrd.tmp.$$"

cp "${WORKDIR}/routstrd" "$STAGED" || die "could not write to ${INSTALL_DIR}."
chmod 755 "$STAGED"

# Validate the staged binary before replacing the target, mirroring
# installStandaloneRelease: refuse a release whose binary reports the wrong
# version rather than replacing a working install and warning about it.
# Skipped for cross-installs (--platform/--arch overrides), where the binary may
# not be able to run on this machine at all.
if [ "$PLATFORM_DETECTED" = 1 ] && [ "$ARCH_DETECTED" = 1 ]; then
  staged_version="$("$STAGED" --version 2>/dev/null || true)"
  if [ "$staged_version" != "$VERSION" ] && [ "$staged_version" != "v$VERSION" ]; then
    die "staged routstrd reported version '${staged_version:-unknown}' instead of '${VERSION}'."
  fi
fi

# Rename over the target so a running daemon keeps its old inode.
mv -f "$STAGED" "$TARGET" || die "could not install to ${TARGET}."
STAGED=""

say "Installed routstrd v${VERSION} to ${TARGET}"

case ":${PATH:-}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    say ""
    say "${INSTALL_DIR} is not in PATH. Add it to your shell profile:"
    say "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
