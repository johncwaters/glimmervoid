#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
npx --no-install playwright-core install chromium webkit firefox
if [ "$(uname -s)" = "Linux" ]; then
  sudo npx --no-install playwright-core install-deps chromium webkit firefox
fi
echo "Chromium, WebKit and Firefox installed. Run: npm run test:browser:engines -- --only rail-drag"
