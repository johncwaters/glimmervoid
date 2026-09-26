<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-09-26 -->

# docs

## Purpose
Design documents, postmortems, and operator guides. Background reading for why the architecture is the way it is; not loaded by any code.

## Key Files

| File | Description |
|------|-------------|
| `architecture-overview.html` | Architecture map (self-contained HTML page with inline SVG diagrams per subsystem, open in a browser): tiers, session lifecycle and state machine, detection flow, completion gate, worktree auto-rebase and merge, notification flow, PR review, Radar, usage, packs, Visions, remote mode, timing, storage |
| `postmortem-terminal-detection.md` | Postmortem of the content-scraping detection era; rationale for the structural-signal rewrite and the signal x state matrix |
| `distribution.md` | How Glimmervoid ships: npm registry package published by `publish.yml` from a release tag via trusted publishing, the release steps, the update check, and which test or workflow enforces each claim |
| `testing-cli.md` | Manual CLI checks to run before a release (`--help`, `--version`, `--port`, `--config`, `doctor`, `pair`, tarball, global install); its `--help` block and every command it names are pinned by `tests/cli-docs.test.ts` |
| `configuration.md` | GENERATED config and environment reference (`npm run docs:config`, `scripts/generate-config-docs.ts`); never edit by hand, `tests/config-docs.test.ts` fails on drift |
| `troubleshooting.md` | Install and startup failures: PATH, node-pty under npm 12's install-script policy, port and bind refusals, the legacy `github:` install |

## For AI Agents

### Working In This Directory
- Docs are historical context: when a doc conflicts with `AGENTS.md` or the code, the code and `AGENTS.md` win.
- Keep the no-dash/no-emoji house style in any new doc.
- Detection work should cite `postmortem-terminal-detection.md` rather than restating it.

### Testing Requirements
- A setting, config key or `GLIMMERVOID_*` variable change means rerunning `npm run docs:config`.
- A CLI command named in these docs or the README must exist in `--help` (`tests/cli-docs.test.ts`).

## Dependencies

### Internal
- Referenced by `AGENTS.md` and code comments (notably detection and spawn-gate modules).

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
