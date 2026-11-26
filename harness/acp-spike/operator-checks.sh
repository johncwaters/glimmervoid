#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

scratch_home="$(mktemp -d)"
trap 'rm -rf "$scratch_home"' EXIT

read_key() {
  local prompt="$1"
  local key=""
  read -r -s -p "$prompt (empty skips): " key
  echo >&2
  printf '%s' "$key"
}

board_id="${1:-}"
if [ -n "${GLIMMERVOID_MCP_TOKEN:-}" ] && [ -n "$board_id" ]; then
  for agent in claude codex antigravity; do
    node harness/acp-spike/run.ts --agent "$agent" --scenario mcp --board "$board_id" --label toplevel || echo "$agent mcp run failed: $?"
  done
  echo "Each agent asked Glimmervoid to spawn a session named acp-spike-probe: close those cards when done."
else
  echo "Skipping the MCP spawn check: run this from a top-level Glimmervoid session terminal, passing a board id: $0 <board id>"
fi

anthropic_key="$(read_key 'ANTHROPIC_API_KEY for Claude')"
if [ -n "$anthropic_key" ]; then
  mkdir -p "$scratch_home/claude"
  CLAUDE_CONFIG_DIR="$scratch_home/claude" ANTHROPIC_API_KEY="$anthropic_key" \
    node harness/acp-spike/run.ts --agent claude --scenario setup --label apikey || echo "claude api key run failed: $?"
fi

openai_key="$(read_key 'OPENAI_API_KEY for Codex')"
if [ -n "$openai_key" ]; then
  mkdir -p "$scratch_home/codex"
  CODEX_HOME="$scratch_home/codex" OPENAI_API_KEY="$openai_key" \
    node harness/acp-spike/run.ts --agent codex --scenario setup --authenticate api-key --label apikey || echo "codex api key run failed: $?"
fi

gemini_key="$(read_key 'GEMINI_API_KEY for Antigravity')"
if [ -n "$gemini_key" ]; then
  GEMINI_API_KEY="$gemini_key" \
    node harness/acp-spike/run.ts --agent antigravity --scenario setup --authenticate gemini-api-key --label apikey || echo "antigravity api key run failed: $?"
fi

echo "Recordings: harness/acp-spike/recordings/<agent>/setup-apikey.* and mcp-toplevel.*. Checking them for the keys:"
for key in "$anthropic_key" "$openai_key" "$gemini_key"; do
  [ -n "$key" ] && grep -rlF -- "$key" harness/acp-spike/recordings && echo "KEY FOUND IN A RECORDING ABOVE: delete it" || true
done
