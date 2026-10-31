#!/usr/bin/env bash
# Atomic release / rollback of the Shadow Swap static build on a VPS (run MANUALLY, as the
# dedicated deploy user). Touches ONLY /srv/shadow-swap. Never restarts or reloads any
# service: the web server already serves /srv/shadow-swap/current, and a symlink swap is atomic.
#
#   release.sh deploy  <path-to-built-dist> <git-sha>   # install a new release and switch to it
#   release.sh rollback                                  # switch back to the previous release
#   release.sh list
set -euo pipefail
BASE=/srv/shadow-swap
RELEASES="$BASE/releases"
case "${1:-}" in
  deploy)
    SRC="${2:?path to dist}"; SHA="${3:?git sha}"
    [[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || { echo "sha must be hex" >&2; exit 1; }
    for f in index.html _headers _redirects; do test -f "$SRC/$f" || { echo "missing $SRC/$f" >&2; exit 1; }; done
    ls "$SRC"/assets/ootle_wasm_bor_bg-*.wasm >/dev/null || { echo "decoder asset missing" >&2; exit 1; }
    DEST="$RELEASES/$(date -u +%Y%m%dT%H%M%SZ)-$SHA"
    mkdir -p "$DEST" && cp -a "$SRC"/. "$DEST"/ && chmod -R a-w "$DEST"
    [ -L "$BASE/current" ] && ln -sfn "$(readlink "$BASE/current")" "$BASE/previous"
    ln -sfn "$DEST" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
    echo "current -> $DEST" ;;
  rollback)
    PREV="$(readlink "$BASE/previous" || true)"
    [ -n "$PREV" ] && [ -d "$PREV" ] || { echo "no previous release recorded" >&2; exit 1; }
    CUR="$(readlink "$BASE/current")"
    ln -sfn "$PREV" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
    ln -sfn "$CUR" "$BASE/previous"
    echo "rolled back: current -> $PREV" ;;
  list) ls -1 "$RELEASES"; echo "current -> $(readlink "$BASE/current" || echo none)"; echo "previous -> $(readlink "$BASE/previous" || echo none)" ;;
  *) echo "usage: release.sh deploy <dist> <sha> | rollback | list" >&2; exit 2 ;;
esac
