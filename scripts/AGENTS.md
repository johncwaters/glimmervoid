<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# scripts

## Purpose
Maintainer scripts for cutting a release, validating the install tarball and generating docs. A release tag's standalone binaries are built and published by `.github/workflows/release.yml`, never from a local machine; npm stopped at 0.54.0 (see `../docs/distribution.md`).

## Key Files

| File | Description |
|------|-------------|
| `release.ts` | Release pipeline: pushes to GitHub, tags, creates the draft GitHub release; the tag push triggers the binary build in CI. Run as `npm run release` |
| `generate-config-docs.ts` | Renders `../docs/configuration.md` from the settings map, the config schema and defaults, plus its env var table (`npm run docs:config`); the config-docs gate fails on drift or an undocumented `GLIMMERVOID_*` read |
| `generate-animal-sprites.ts` | Renders the flying animals' pixel sources (`../public/animals/*.txt`: a header of palette, `outline`, `halo` and `wrap` lines, then one block per frame) to the PNGs beside them, baking in the outline and halo (`npm run animals:build`); the animal-sprites gate fails on a stale PNG or a sprite breaking the frame, color or margin rules |
| `build.mjs`, `prepare-build.js`, `postinstall.mjs` | Stay plain `.js`: npm runs them INSIDE `node_modules` on a git install, where Node refuses type stripping |
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
