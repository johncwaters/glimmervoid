# Distributing Glimmervoid

Glimmervoid ships as the `glimmervoid` package on the npm registry, built and published by CI from a release tag. The GitHub repo stays the source of truth; the registry only carries the built `dist/`, because Node refuses type stripping inside `node_modules`, so an installed package can only run compiled `.js`.

The install and update commands are in the README Quickstart; the traps around node-pty and npm 12's install-script policy are in `troubleshooting.md`.

## Releases

1. Move the `## [Unreleased]` entries in `CHANGELOG.md` under the new version, bump `version` in `package.json`, and commit both.
2. Run `npm run release` (`scripts/release.ts`) on a clean `main`. It refuses any other branch, and a `main` that is behind or diverged from `origin/main`, before touching anything; then it builds, checks the tarball ships `dist/bin/glimmervoid.js` and no raw `.ts`, pushes `main`, creates and pushes the annotated `vX.Y.Z` tag, and creates the GitHub release from the changelog entry with the packed tarballs already attached, so the release never goes live without them. Nothing is published from the local machine.
3. The tag push runs `.github/workflows/publish.yml`: it refuses a tag that does not match `package.json` or whose commit is not on `origin/main`, runs `npm ci`, the build and the test suite, then `npm publish --provenance --access public`.

Publishing uses npm trusted publishing (OIDC from GitHub Actions, hence the workflow's `id-token: write`), so no npm token is stored in the repo. Trusted publishing only works for a package that already exists, which is why every CI publish before 0.29.1 failed with `E404 PUT`: a new package name needs one manual publish by the owner and `johncwaters/glimmervoid` with `publish.yml` added as the trusted publisher on npmjs.com before CI can publish. Provenance comes only from the workflow's `--provenance` flag, never from `publishConfig`, because npm refuses provenance outside a supported CI provider.

The `POSTHOG_CLI_API_KEY` repository secret (a PostHog personal API key with error tracking and annotation write on project 640352) links each published version to its PostHog release and annotates it; without it, or when PostHog fails, the publish goes ahead unlinked.

Release tarball assets stay only to migrate pre-0.29.1 tarball installs: their cached update banners still point to a versioned asset. Drop `scripts/pack-release-tarballs.ts`, `.github/workflows/release-tarball.yml` and the asset upload in `scripts/release.ts` one release after 0.29.1's successor ships.

## Updates

Global npm installs and npx launches check npm because their update commands resolve there; clones check release tags so unreleased commits do not trigger the release banner. The npx banner pins `npx glimmervoid@<version>` to avoid reusing an older cached spec, with `--allow-scripts=node-pty` before the package spec on Linux because node-pty needs compilation. `tests/update-core.test.ts` and `tests/update-check.test.ts` pin the commands, sources and legacy-cache refresh.

## What is enforced, and where

- The update check (installed identity, latest release sources, advisory-only failure paths, the per-install update command, the persisted throttle): `tests/update-check.test.ts` and `tests/update-core.test.ts`.
- Dashboard-driven update staging, guarded handoff, startup recovery and lifecycle coordination: `tests/update-apply.test.ts`, `tests/update-apply-core.test.ts`, `tests/recover-handoff.test.ts`, `tests/server-lifecycle.test.ts` and `tests/git-workspace-session.test.ts`.
- The `files` whitelist covering every module the entry points need: the packaged global install step in `.github/workflows/test.yml` installs the real tarball with npm 12 and fails unless `glimmervoid doctor` reports node-pty loading.
- The tag matching `package.json`, its commit being on `main`, and the suite passing before anything is published: `.github/workflows/publish.yml`.
- CI and publishing on the same Node as development: both workflows read `.nvmrc`.
