#!/usr/bin/env bash
# Build the Lighter L2 signer to WebAssembly and install it into apps/perps.
#
# The venue ships signing SDKs for Go and Python only, and the signer is a Go
# binary. This compiles their Go SDK to wasm so orders can be signed in the
# browser, which is where a Lighter API key has to stay: the key carries write
# permission, so a server holding one is a honeypot.
#
# The commit is pinned because packages/lighter/src/signer.ts declares the
# exported function signatures by hand. A newer SDK that renames or reorders an
# argument would still load and would still return something — it would just
# sign the wrong bytes. Bump this only together with those declarations.
#
# Requires Go >= 1.23 and git. Run from anywhere: pnpm signer:build
set -euo pipefail

COMMIT=c26ac340ce5d2e237c555949b6ab0927bd09e0df
REPO=https://github.com/elliottech/lighter-go
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/apps/perps/public/signer"
WORK="$(mktemp -d)"

trap 'rm -rf "$WORK"' EXIT

echo "cloning $REPO"
git clone --quiet "$REPO" "$WORK/lighter-go"
git -C "$WORK/lighter-go" checkout --quiet "$COMMIT"

echo "building wasm (GOOS=js GOARCH=wasm)"
cd "$WORK/lighter-go"
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$WORK/lighter-signer.wasm" ./wasm/

mkdir -p "$DEST"
cp "$WORK/lighter-signer.wasm" "$DEST/lighter-signer.wasm"
# The Go runtime shim must come from the same toolchain that built the module.
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$DEST/wasm_exec.js"

cat > "$DEST/BUILD.txt" <<EOF
lighter-signer.wasm
  source:  $REPO
  commit:  $COMMIT
  built:   $(date -u +%Y-%m-%dT%H:%M:%SZ)
  go:      $(go version)

wasm_exec.js comes from the same Go toolchain and must be rebuilt with the wasm.
Rebuild both with: pnpm signer:build
EOF

echo "installed in $DEST"
ls -la "$DEST"
