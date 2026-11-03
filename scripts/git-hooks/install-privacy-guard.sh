#!/usr/bin/env bash
# One-time per-machine setup. NON-DESTRUCTIVE: refuses to clobber an existing
# global hooks path, and chains to any existing pre-push hook instead of replacing.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/pre-push"
existing="$(git config --global core.hooksPath || true)"
if [ -n "$existing" ] && [ "$existing" != "$HOME/.git-hooks-global" ]; then
  echo "NOTICE: core.hooksPath is already set to: $existing"
  echo "Not overwriting. To add the guard, copy '$SRC' into '$existing/pre-push'"
  echo "(or chain it from your existing pre-push). Aborting to avoid clobbering your setup."
  exit 2
fi
HOOKS="$HOME/.git-hooks-global"; mkdir -p "$HOOKS"
if [ -e "$HOOKS/pre-push" ] && ! grep -q 'PRIVACY GUARD' "$HOOKS/pre-push" 2>/dev/null; then
  echo "NOTICE: $HOOKS/pre-push already exists and is not this guard."
  cp "$HOOKS/pre-push" "$HOOKS/pre-push.backup.$(date +%s)"
  echo "Backed it up to pre-push.backup.*; please merge the two manually."
  exit 2
fi
cp "$SRC" "$HOOKS/pre-push"; chmod +x "$HOOKS/pre-push"
git config --global core.hooksPath "$HOOKS"
# Anonymous identity only if one is not already set.
[ -z "$(git config --global user.email || true)" ] && git config --global user.email "304655218+GSXRspartan@users.noreply.github.com"
[ -z "$(git config --global user.name  || true)" ] && git config --global user.name  "GSXRspartan"
echo "Installed global pre-push privacy guard at $HOOKS/pre-push."
echo "Windows: run in Git Bash (Git for Windows ships the bash this hook uses)."
