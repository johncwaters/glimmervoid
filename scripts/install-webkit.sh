#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
npx --no-install playwright-core install webkit
if [ "$(uname -s)" = "Linux" ]; then
  sudo npx --no-install playwright-core install-deps webkit
fi
echo "WebKit installed. Run: npm run test:browser -- --only boards --viewport desktop-1280 --browser webkit"
