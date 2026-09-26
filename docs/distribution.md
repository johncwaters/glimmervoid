# Distributing Glimmervoid

Glimmervoid ships as the `glimmervoid` package on the npm registry, built and published by CI from a release tag. The GitHub repo stays the source of truth; the registry only carries the built `dist/`, because Node refuses type stripping inside `node_modules`, so an installed package can only run compiled `.js`.

The install and update commands are in the README Quickstart; the traps around node-pty and npm 12's install-script policy are in `troubleshooting.md`.

## Releases

1. Move the `## [Unreleased]` entries in `CHANGELOG.md` under the new version, bump `version` in `package.json`, and commit both.
2. Run `npm run release` (`scripts/release.ts`) on a clean `main`. It refuses any other branch, and a `main` that is behind or diverged from `origin/main`, before touching anything; then it builds, checks the tarball ships `dist/bin/glimmervoid.js` and no raw `.ts`, pushes `main`, creates and pushes the annotated `vX.Y.Z` tag, and creates the GitHub release from the changelog entry. Nothing is published from the local machine.
3. The tag push runs `.github/workflows/publish.yml`: it refuses a tag that does not match `package.json` or whose commit is not on `origin/main`, runs `npm ci`, the build and the test suite, then `npm publish --provenance --access public`.

Publishing uses npm trusted publishing (OIDC from GitHub Actions, hence the workflow's `id-token: write`), so no npm token is stored in the repo. Trusted publishing can only be configured for a package that already exists, so the very first version must be published once by hand (`npm publish --access public` by the package owner from a clean, built checkout of the tag), and then `johncwaters/glimmervoid` with the `publish.yml` workflow is added as the trusted publisher in the package settings on npmjs.com. Provenance comes only from the workflow's `--provenance` flag, never from `publishConfig`, because npm refuses to generate provenance outside a supported CI provider and would fail that manual first publish.

## Updates

The running server's update check keys on the latest release, never on the tip of `main`, so unreleased commits never trigger the banner. The source depends on how Glimmervoid was installed: a global npm install reads the registry's `latest` dist-tag (`https://registry.npmjs.org/glimmervoid/latest`), since that is what `npm install -g` would fetch; a clone reads the latest `vX.Y.Z` tag (from `git ls-remote`, falling back to the GitHub releases API). It is advisory, rechecks daily while a dashboard is connected, and persists a 6 hour throttle in `~/.glimmervoid/update-check.json`. For a registry install it offers `npm install -g glimmervoid@<version>` (plus `--allow-scripts=node-pty` on Linux); for a clone it offers `git pull --ff-only && npm ci && npm run build`.

## What is enforced, and where

- The update check (installed identity, latest release sources, advisory-only failure paths, the per-install update command, the persisted throttle): `tests/update-check.test.ts` and `tests/update-core.test.ts`.
- Dashboard-driven update staging, guarded handoff, startup recovery and lifecycle coordination: `tests/update-apply.test.ts`, `tests/update-apply-core.test.ts`, `tests/recover-handoff.test.ts`, `tests/server-lifecycle.test.ts` and `tests/git-workspace-session.test.ts`.
- The `files` whitelist covering every module the entry points need, and every shipped pack spec having its sources inside the tarball: the packaged global install step in `.github/workflows/test.yml` installs the real tarball with npm 12 and fails unless `glimmervoid doctor` reports node-pty loading.
- The tag matching `package.json`, its commit being on `main`, and the suite passing before anything is published: `.github/workflows/publish.yml`.
- CI and publishing on the same Node as development: both workflows read `.nvmrc`.
