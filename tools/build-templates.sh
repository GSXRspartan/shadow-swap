#!/usr/bin/env bash
# Reproducible release build of the Shadow Swap Ootle templates (four published before the
# v0.48 reset, plus the unpublished SwapOffer escrow, so its bytes are fixed before anyone publishes it).
#
# WHY: a plain `cargo build` embeds absolute host paths (e.g. `/root/.cargo/git/checkouts/...`)
# into the WASM via panic-location strings, so two machines building the same commit produce
# DIFFERENT bytes, and therefore different template binary hashes and different template
# addresses. That makes "this published template is this source" unverifiable.
#
# This script removes both sources of variance it controls:
#   1. toolchain  -> pinned to TOOLCHAIN below (the same channel upstream tari-ootle v0.48.0 pins);
#   2. host paths -> remapped with --remap-path-prefix for CARGO_HOME and the repo root.
# and builds with --locked, so the committed Cargo.lock files are used as-is.
#
# Usage:
#   tools/build-templates.sh            # build and print sha256 + size per template
#   tools/build-templates.sh --check    # also compare against templates/WASM_SHA256SUMS (CI)
#   tools/build-templates.sh --write    # rewrite templates/WASM_SHA256SUMS
set -euo pipefail

TOOLCHAIN="1.97.1"
TEMPLATES=(fungible_pool nft_marketplace nft_item_offer nft_collection_bid p2p_offer)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
SUMS="$ROOT/templates/WASM_SHA256SUMS"

if ! rustup run "$TOOLCHAIN" rustc --version >/dev/null 2>&1; then
  echo "Rust $TOOLCHAIN is required: rustup toolchain install $TOOLCHAIN --profile minimal --target wasm32-unknown-unknown" >&2
  exit 2
fi

# rustc applies the LAST matching --remap-path-prefix, so the CARGO_HOME mapping comes last:
# it must win even when CARGO_HOME lives inside the checkout (as it does in some CI layouts).
export RUSTFLAGS="--remap-path-prefix=${ROOT}=/shadow-swap --remap-path-prefix=${CARGO_HOME_DIR}=/cargo"
# A target dir per template, outside the source tree's default, so a non-reproducible
# incremental build (different RUSTFLAGS) can never be mistaken for this one.
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

: > "$OUT/sums"
for t in "${TEMPLATES[@]}"; do
  rustup run "$TOOLCHAIN" cargo build --quiet --locked --release --target wasm32-unknown-unknown \
    --manifest-path "$ROOT/templates/$t/Cargo.toml" --target-dir "$OUT/target-$t"
  wasm="$OUT/target-$t/wasm32-unknown-unknown/release/$t.wasm"
  if strings "$wasm" | grep -qE "$CARGO_HOME_DIR|$ROOT"; then
    echo "error: $t.wasm still embeds a host path; the build is not reproducible" >&2
    exit 1
  fi
  printf '%s  %s.wasm\n' "$(sha256sum "$wasm" | cut -d' ' -f1)" "$t" >> "$OUT/sums"
  printf '%-20s %8s bytes  %s\n' "$t" "$(stat -c %s "$wasm")" "$(sha256sum "$wasm" | cut -d' ' -f1)"
done

case "${1:-}" in
  --write)
    { echo "# sha256 of the reproducible template builds (tools/build-templates.sh, Rust $TOOLCHAIN,"
      echo "# tari-ootle v0.48.0 6a25dbc). Regenerate with: tools/build-templates.sh --write"
      cat "$OUT/sums"; } > "$SUMS"
    echo "wrote $SUMS" ;;
  --check)
    if diff <(grep -v '^#' "$SUMS") "$OUT/sums"; then echo "reproducible: hashes match $SUMS"; else echo "error: template hashes differ from $SUMS" >&2; exit 1; fi ;;
esac
