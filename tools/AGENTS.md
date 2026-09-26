<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# tools

## Purpose
Editor tooling: `vscode-visions/` is built into `dist/` and packed into a VSIX at runtime by `server/visions-setup.ts`, so it ships.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `vscode-visions/` | Minimal VS Code extension that launches the Glimmervoid Visions markdown LSP relay |

## For AI Agents

### Working In This Directory
- Keep tools self-contained; do not import Glimmervoid server modules from here.

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
