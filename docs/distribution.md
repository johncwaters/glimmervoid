# Distributing Glimmervoid

Glimmervoid ships as standalone binaries for five targets, built from one release tag. The npm package stopped at 0.54.0: an npm or npx install of that version switches itself to the standalone app through the dashboard's Update, and every older npm version is deprecated with a message pointing at the installer. Ending npm removed the Node prerequisite and the node-pty compile step every npm install needed.

Install and update commands are in the [README Quickstart](../README.md#quickstart).

## Releases

1. Move the `## [Unreleased]` entries in `CHANGELOG.md` under the new version, bump `version` in `package.json`, and commit both.
2. Run `npm run release` (`scripts/release.ts`) from a clean checkout on any branch, so a Glimmervoid session worktree can cut it while the main checkout stays read-only. It captures HEAD once, dispatches `test.yml` on that commit and waits for it to pass, then tags exactly that commit. The main checkout is a holding worktree that other sessions' promotions fast-forward mid-run, so tagging whatever HEAD is after the wait once shipped an untested commit. It then creates the GitHub release as a draft from the changelog entry.

## Standalone binaries

The binaries are Node single executable applications built by `@yao-pkg/pkg --sea`, so an install needs no Node. Installers, the Homebrew formula and the updater come from axodotdev dist, configured in `dist-workspace.toml`; `.github/workflows/release.yml` is generated from it by `dist generate` and must never be edited by hand, because `dist plan` refuses a workflow that drifted from the config. Each target builds on its own native runner, since pkg cannot cross-compile native modules (node-pty, sharp). macOS binaries carry only the ad-hoc signature pkg applies, so no paid signing identity is involved; the curl and PowerShell installers download with tools that set no quarantine or Mark of the Web flag.

dist builds through the npm `dist` script, which writes the binary to the package root where dist collects it.

Each archive also carries `glimmervoid-fnox`, the pinned fnox Glimmervoid reads secrets through, declared as a second `bin` so the archive, the installers, the Homebrew formula and the updater all place it beside `glimmervoid`. It is named `glimmervoid-fnox` because a `fnox` in `~/.glimmervoid/bin` would shadow the operator's own fnox and clash with Homebrew's fnox formula. `scripts/fnox-release.json` pins the version and each target's archive sha256, and `scripts/fetch-fnox.ts` refuses an archive that does not match; `npm run dev` fetches the same pin into the gitignored `.fnox/`.

`npm run release` creates the GitHub release as a draft; the tag push runs `release.yml`, which uploads the archives, installers and checksums to that draft and publishes it, then pushes the formula to `johncwaters/homebrew-tap` with the `HOMEBREW_TAP_TOKEN` secret.

## Updates

Every install learns about new versions from the latest GitHub release through the GitHub API, and a release whose notes carry a `### Security` section shows a security notice to older installs. A clone resolves the release commit with `git ls-remote` against origin, so a release it has not fetched yet can still be applied.

## What is enforced, and where

- The npm and npx switch to the standalone app, and the standalone binary updater run: `tests/update-apply-npm.test.ts`.
- A clone's dashboard update, guarded handoff and startup recovery: `tests/update-apply-clone-handoff.test.ts` and `tests/recover-handoff.test.ts`.
- CI and releases on the same Node as development: every workflow reads `.nvmrc`.
- `release.yml` matching `dist-workspace.toml`: `dist plan` fails on any drift.
- The fnox archive for every target matching its pin: `node scripts/fetch-fnox.ts --target <target> --check-only`.
