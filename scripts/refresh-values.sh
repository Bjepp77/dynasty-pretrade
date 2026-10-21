#!/usr/bin/env bash
# Refresh data/values.json and commit it LOCALLY. Never pushes.
# Usage: bash scripts/refresh-values.sh   (see docs/refresh.md)
set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
mkdir -p .cache
LOG=.cache/refresh.log
say() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG"; }
# launchd has a minimal PATH; add common node locations
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
say "start"
if ! node scripts/fetch-values.mjs >>"$LOG" 2>&1; then
  say "FAILED: fetch-values.mjs exited non-zero; values.json left as is"
  exit 1
fi
if git diff --quiet -- data/values.json; then
  say "no change"
  exit 0
fi
if git add data/values.json && git commit -m "Refresh market values $(date +%F)" -- data/values.json >>"$LOG" 2>&1; then
  say "committed locally (not pushed)"
else
  say "FAILED: git commit"
  exit 1
fi
