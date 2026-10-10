<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-07-31 -->

# assets

## Purpose
Repo-level static assets for documentation, served as Vite's `publicDir`. The only third-party media here is the bundled CommitMono font, which ships with its SIL OFL licence beside it (`tests/bundled-fonts.test.ts`), plus `octicons-LICENSE.txt`, the MIT licence for the Octicons paths copied into `public/pr-status-icon.ts`. Built-in alert sounds are synthesized in `public/alert-sound-core.ts`, and operator sounds are served from `<glimmervoid home>/sounds/` by `server/custom-sounds-routes.ts`.

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `fonts/` | CommitMono woff2 faces (400/700, upright and italic) plus `CommitMono-OFL.txt`; the OFL requires the licence to travel with the files |
| `pictures/` | Screenshots and demo media for README/docs (`glimmervoid-demo.gif` README hero: a real Claude Code session mid-run, captured via Playwright driving an actual Glimmervoid instance) |

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
