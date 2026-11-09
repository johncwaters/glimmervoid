#!/usr/bin/env bash
set -uo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
trap 'exit 130' INT
for argument in "$@"; do
  case "$argument" in
    --browser|--executable)
      echo "test:browser:engines picks each engine itself, so it does not take $argument" >&2
      exit 2
      ;;
  esac
done
failed_engines=()
for engine in chromium webkit firefox; do
  echo "== $engine"
  if ! node harness/browser/harness.ts --browser "$engine" "$@"; then
    failed_engines+=("$engine")
  fi
done
if [ "${#failed_engines[@]}" -gt 0 ]; then
  echo "browser matrix failed in: ${failed_engines[*]}" >&2
  exit 1
fi
echo "browser matrix passed in chromium, webkit, firefox"
