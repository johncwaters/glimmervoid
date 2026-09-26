<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-09-26 -->

# bin

## Purpose
The globally-installed CLI entry point for Glimmervoid (`npm install -g glimmervoid` from the npm registry, see `../docs/distribution.md`). Parses CLI flags and boots the production server.

## Key Files

| File | Description |
|------|-------------|
| `glimmervoid.ts` | `#!/usr/bin/env node` launcher: parses flags, sets env vars, dispatches the CLI-only commands listed by `--help`, then boots the server; a new command also goes into the `--help` text, which `../tests/cli-docs.test.ts` checks the docs against |
| `path-doctor.ts` | Pure PATH helpers shared by `glimmervoid doctor` and the post-install PATH notice |

## For AI Agents

### Working In This Directory
- Keep this a thin argv parser; real logic belongs in `server/backend.ts` or `server/config-store.ts`.
- `package.json` `bin` points at the BUILT CLI under `dist/`, so a new local import rides the bundle and needs no `files` entry; the packaged-install job in `.github/workflows/test.yml` is still the gate.

### Testing Requirements
- `npm test` for behavior; the packaged-install CI job proves the installed CLI runs from `dist/`.

## Dependencies

### Internal
- `../server/main.ts` / `../server/backend.ts` - the server it boots
- `../server/config-store.ts` - config resolution

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
