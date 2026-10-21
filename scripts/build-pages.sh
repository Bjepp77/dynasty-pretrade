#!/usr/bin/env bash
# Builds the GitHub Pages-ready static site into dist/ (gitignored). No build tools: the app is plain HTML/JS.
# Usage: bash scripts/build-pages.sh   then preview: python3 -m http.server -d dist 8790
# PUBLIC=1 (default) blanks the prefilled Sleeper league ID so a public visitor does not land on a private league's
# manager names. PUBLIC=0 keeps it.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist/data dist/docs
cp index.html style.css scoring.js sim.js league.js suggest.js app.js dist/
cp data/values.json data/stats.json data/sos.json dist/data/
cp docs/*.md dist/docs/
touch dist/.nojekyll # serve files as-is
if [ "${PUBLIC:-1}" = "1" ]; then
  sed -i.bak 's/^const DEFAULT_LEAGUE = "[0-9]*";/const DEFAULT_LEAGUE = "";/' dist/app.js && rm dist/app.js.bak
  grep -q '^const DEFAULT_LEAGUE = "";' dist/app.js || { echo "build: could not blank DEFAULT_LEAGUE" >&2; exit 1; }
fi
for f in dist/data/*.json; do node -e 'JSON.parse(require("fs").readFileSync(process.argv[1]))' "$f"; done
echo "built dist/ ($(du -sh dist | cut -f1)), data snapshot $(node -p 'require("./dist/data/values.json").generated')"
