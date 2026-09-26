<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# scripts

## Purpose
Maintainer scripts for cutting a release, validating the install tarball and generating docs. A release tag is published to npm by `.github/workflows/publish.yml`, never from a local machine (see `../docs/distribution.md`).

## Key Files

| File | Description |
|------|-------------|
| `release.ts` | Release pipeline: pushes to GitHub, tags, creates the GitHub release; the tag push triggers the npm publish in CI. Run as `npm run release` |
| `generate-config-docs.ts` | Renders `../docs/configuration.md` from the settings map, the config schema and defaults, plus its env var table (`npm run docs:config`); `../tests/config-docs.test.ts` fails on drift or an undocumented `GLIMMERVOID_*` read |
| `memory-purge-fixtures.ts` | Removes test-fixture records from a memory database (`node scripts/memory-purge-fixtures.ts <db-path> [--dry-run]`), backing it up first and expunging through the store's own three writes |
| `build.mjs`, `prepare-build.js`, `postinstall.mjs` | Stay plain `.js`: npm runs them INSIDE `node_modules` on a git install, where Node refuses type stripping |
| `postinstall-path-check.ts` | The PATH notice itself, bundled to `dist/` and reached through `postinstall.mjs` |

## For AI Agents

### Working In This Directory
- After adding a server module that ships, check `package.json` `files`; a miss means a broken global install, which the packaged-install step in `.github/workflows/test.yml` catches.
- These are one-shot cold paths: sync `execSync`/fs is acceptable here (unlike server runtime paths).

### Testing Requirements
- Run the script itself; `generate-config-docs.ts` is also covered by `../tests/config-docs.test.ts`.

## Dependencies

### Internal
- `../package.json` - the `files` whitelist and entry points they validate before a release

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
