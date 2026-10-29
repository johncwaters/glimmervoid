<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# scripts

## Purpose
Maintainer scripts for cutting a release, validating the install tarball and generating docs. A release tag is published to npm by `.github/workflows/publish.yml`, never from a local machine (see `../docs/distribution.md`).

## Key Files

| File | Description |
|------|-------------|
| `release.ts` | Release pipeline: pushes to GitHub, tags, creates the GitHub release; the tag push triggers the npm publish in CI. Run as `npm run release` |
| `generate-config-docs.ts` | Renders `../docs/configuration.md` from the settings map, the config schema and defaults, plus its env var table (`npm run docs:config`); the config-docs gate fails on drift or an undocumented `GLIMMERVOID_*` read |
| `generate-animal-sprites.ts` | Renders the flying animals' pixel sources (`../public/animals/*.txt`: a header of palette, `outline`, `halo` and `wrap` lines, then one block per frame) to the PNGs beside them, baking in the outline and halo (`npm run animals:build`); the animal-sprites gate fails on a stale PNG or a sprite breaking the frame, color or margin rules |
| `build.mjs`, `prepare-build.js`, `postinstall.mjs` | Stay plain `.js`: npm runs them INSIDE `node_modules` on a git install, where Node refuses type stripping |
| `probe-guardrails-roles.ts` | Live guardrails role probe through the real session spawn; run after an agent CLI or sandbox runtime upgrade or any role change (`node scripts/probe-guardrails-roles.ts [--role check\|judge\|worker\|judge-lane\|review\|resize\|keep-mergeable\|team-review\|posthog\|session] [--agent claude-code\|codex]`) |
| `postinstall-path-check.ts` | The PATH notice itself, bundled to `dist/` and reached through `postinstall.mjs` |

## For AI Agents

### Working In This Directory
- After adding a server module that ships, check `package.json` `files`; a miss means a broken global install, which the packaged-install step in `.github/workflows/test.yml` catches.
- These are one-shot cold paths: sync `execSync`/fs is acceptable here (unlike server runtime paths).

### Testing Requirements
- Run the script itself; `generate-config-docs.ts` is also covered by the config-docs gate.

## Dependencies

### Internal
- `../package.json` - the `files` whitelist and entry points they validate before a release

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
