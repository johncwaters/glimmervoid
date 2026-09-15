# Distributing Glimmervoid

Glimmervoid is not an npm package. Nothing is published to any registry (`package.json` is `"private": true`), and the GitHub repo (`github.com/johncwaters/glimmervoid`) is the only source of truth. npm appears below purely as the install tool: a `github:` spec install clones this repo and packs it locally, never touching a registry.

## Server machines

Provisioning and updating are owned by the operator's dotfiles repo. Its server profile:

1. Clones `https://github.com/johncwaters/glimmervoid.git` to `~/Projects/glimmervoid`.
2. Ensures Linux has the node-pty build tools: `sudo apt install build-essential python3`.
3. Runs `npm ci` then `npm run build`.
4. Installs a systemd user unit (`glimmervoid.service`) and enables linger so it survives logout.
5. Fronts the remote listener with `tailscale serve`.

To update a server, re-run the dotfiles apply script; it does `git pull --ff-only`, `npm ci`, `npm run build`, and restarts the service. By hand, the same sequence is:

```bash
cd ~/Projects/glimmervoid
git pull --ff-only && npm ci && npm run build
systemctl --user restart glimmervoid
```

## Standalone CLI

For a machine that only needs the `glimmervoid` command (npm 12 or newer required). Windows and macOS (node-pty prebuilds ship, and `prepare` builds `dist/` during npm's git preparation regardless of the scripts policy):

```bash
npm install -g github:johncwaters/glimmervoid --allow-git=root
```

Linux additionally needs node-pty compiled, which npm 12's default script-skipping prevents at install time. Install normally, then compile node-pty on its own:

```bash
npm install -g github:johncwaters/glimmervoid --allow-git=root
npm rebuild -g node-pty --allow-scripts=node-pty
```

Folding both into one command also works, at the cost of a far broader scripts opt-in:

```bash
npm install -g github:johncwaters/glimmervoid --allow-git=root --dangerously-allow-all-scripts
```

On an older npm, run the same command through `npx npm@12 install -g ...`. The floor is hard: npm 11 global installs from git specs land as a link into npm's cache temp clone, which npm then deletes (npm/cli#9406, fixed by pacote 22 which ships in npm 12). `--allow-git=root` is npm 12's opt-in for git dependencies, scoped to the root package.

Why the rebuild is a separate step, verified against npm 12.0.2: any `allow-scripts` value, whether from the command line or from any npmrc, propagates into the project-scoped child install npm uses to prepare a git dependency, and that child refuses it with `EALLOWSCRIPTS`. So the targeted flag cannot ride along on the install command, `~/.npmrc` must carry no `allow-scripts` line while the install runs, and the rebuild must run from a directory outside `$(npm root -g)/glimmervoid`, where it would be project-scoped and fail the same way. A package-level `allowScripts` field in this repo's `package.json` does not help either, because npm 12 reads that field only for project-scoped installs. The broad flag is wider only on the install command, where it runs install scripts for every package in the dependency tree rather than node-pty's alone.

A clone or source checkout takes a different repair, `npm rebuild node-pty --dangerously-allow-all-scripts` run from the checkout root, which is why the boot refusal and `glimmervoid doctor` name both install shapes. `README.md` is authoritative for the install procedure and carries the remaining rebuild traps; keep this page in step with it.

npm packs the repo before installing from a GitHub spec, so `package.json`'s `files` whitelist still bounds exactly what lands in the install.

## Releases

A release is a version bump plus a `CHANGELOG.md` entry plus an annotated `vX.Y.Z` tag pushed to GitHub (`scripts/release.ts`, `npm run release`). Nothing is published anywhere. The running server's update check keys on the latest valid release tag, not on the tip of `main`, so unreleased commits do not trigger the banner. The npm-global update command pins that tag (`github:johncwaters/glimmervoid#vX.Y.Z`); clone updates still use `git pull --ff-only && npm ci && npm run build`. The check is advisory and notify-only, rechecks daily while a dashboard is connected, and persists a 6h throttle in `~/.glimmervoid/update-check.json`.

## What is enforced, and where

Per the repo's docs-must-be-enforceable norm, these claims are pinned by tests rather than by this page:

- The update check (installed identity, latest release sources, advisory-only failure paths, the per-flavor update command, the persisted throttle): `tests/update-check.test.ts` and `tests/update-core.test.ts`, part of `npm test`.
- Dashboard-driven update staging, guarded handoff, startup recovery and lifecycle coordination: `tests/update-apply.test.ts`, `tests/update-apply-core.test.ts`, `tests/recover-handoff.test.ts`, `tests/server-lifecycle.test.ts` and `tests/git-workspace-session.test.ts`, part of `npm test`.
- The `files` whitelist covering every module the entry points require, and every SHIPPED pack spec having its sources inside the tarball (a spec reaching outside `packs/`, like the repo-development `glimmervoid` pack, must be excluded or first boot logs a rebuild failure): the packaged-install job in `.github/workflows/test.yml` installs the real tarball and runs `glimmervoid doctor` against it.

The provisioning flow itself (clone path, systemd unit, tailscale serve, apply script) lives in the dotfiles repo, not here. Treat the steps above as a description of that repo's behavior, and change them there.
