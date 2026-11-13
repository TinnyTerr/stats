#!/usr/bin/env bash
# Usage: scripts/release.sh <major|minor|patch> [--dry-run]
# Bumps package.json, commits "vX.Y.Z", tags it and pushes; CI does the rest.
set -euo pipefail
cd "$(dirname "$0")/.."

kind="${1:-}"; dry="${2:-}"
case "$kind" in major|minor|patch) ;; *) echo "usage: $0 <major|minor|patch> [--dry-run]" >&2; exit 2 ;; esac

[ -z "$(git status --porcelain)" ] || { echo "working tree not clean" >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo "not on main" >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main is not in sync with origin" >&2; exit 1; }

cur="$(sed -n 's/^\s*"version": "\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/p' package.json | head -n1)"
IFS=. read -r ma mi pa <<<"$cur"
case "$kind" in
  major) ma=$((ma+1)); mi=0; pa=0 ;;
  minor) mi=$((mi+1)); pa=0 ;;
  patch) pa=$((pa+1)) ;;
esac
new="$ma.$mi.$pa"
git rev-parse -q --verify "refs/tags/v$new" >/dev/null && { echo "v$new already exists" >&2; exit 1; }

echo "$cur -> $new ($kind)"
[ "$dry" = --dry-run ] && exit 0

sed -i "0,/\"version\": \"$cur\"/s//\"version\": \"$new\"/" package.json
bun test >/dev/null && bun run typecheck >/dev/null || { git checkout package.json; echo "tests/typecheck failed" >&2; exit 1; }
git commit -qam "v$new"
git tag -a "v$new" -m "v$new"
git push -q origin main "v$new"
echo "pushed v$new"
