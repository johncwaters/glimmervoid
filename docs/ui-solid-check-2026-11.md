# Solid 2 Ecosystem and Cost Check (2026-11-26)

Measured on `johncwaters/glimmervoid` 0.66.0 (base commit `e9305b539`, Node v22.23.5, npm 10.9.9, Vite 8.3.8, TypeScript 7.0.2).

Recounted dashboard baseline at `e9305b539`: 2,372 `el(` calls, 645 `addEventListener(` calls, 69 stylesheets (16,237 lines), 18 `.ts` files in `public/ui/` (993 lines).

## U0.1 Registry, Peer Ranges, and Ecosystem Answers

- Solid 2 stable on `latest` (not prerelease-only): **yes**
- Current Solid 2 package set and exact pinned versions:
  - `solid-js`: `2.0.4` (`dist-tags`: `latest: 2.0.4`, `next: 2.0.0-rc.23`, `v1-latest: 1.9.20`, `beta: 1.10.0-beta.0`)
  - `@solidjs/web`: `2.0.4` (`dist-tags`: `latest: 2.0.4`, `next: 2.0.0-rc.23`)
  - `@solidjs/vite-plugin`: `3.0.1` (`dist-tags`: `latest: 3.0.1`, `next: 3.0.0-next.35`)
  - Note on `vite-plugin-solid`: `latest` is `2.11.17` (Solid 1.x, peer `solid-js: ^1.7.2`); `next` (`3.0.0-next.27`) is a deprecation wrapper around `@solidjs/vite-plugin`. The Solid 2 Vite plugin is `@solidjs/vite-plugin`.
- Peer ranges between the three packages:
  - `solid-js@2.0.4`: no `peerDependencies` (runtime deps: `@solidjs/signals: ^2.0.4`, `seroval: ^1.8.0`, `seroval-plugins: ^1.8.0`)
  - `@solidjs/web@2.0.4`: `peerDependencies`: `solid-js: ^2.0.4`
  - `@solidjs/vite-plugin@3.0.1`: required `peerDependencies`: `vite: ^8.0.0 || ^9.0.0`, `solid-js: ^2.0.0`, `@solidjs/web: ^2.0.0` (optional peers: `@babel/core`, `@solidjs/babel-plugin`, `@solidjs/start-devtools`, `@testing-library/jest-dom`)
- `tsconfig` settings requested by installed `node_modules/solid-js/README.md`:
  - `"jsx": "preserve"`
  - `"jsxImportSource": "@solidjs/web"`
- `@ark-ui/solid` allows `solid-js` 2.x today: **yes** (by semver peer range: `latest` `5.40.1` declares `"solid-js": ">=1.6.0"`, and `next` `6.0.0-next.0` also declares `"solid-js": ">=1.6.0"`; not installed and runtime compatibility with Solid 2 was not tested).
- `@kobalte/core` allows `solid-js` 2.x today: **no** on `latest` (`0.13.14` declares `"solid-js": "^1.9.8"`); **yes** on prerelease `alpha` (`2.0.0-alpha.5` declares `"solid-js": "^2.0.0"`, `"@solidjs/web": "^2.0.0"`). Not installed.
- Any repo npm setting, release-age hold, registry policy, or `socket.yml` package list blocked the install: **no** (no `.npmrc` in repo; `socket.yml` lists no individual packages).
- Standalone binary and Node bundles unaffected (`scripts/build.mjs`, `vite.server.config.ts`, `package.json` `pkg.assets`): **yes** (`vite.server.config.ts` does not load `@solidjs/vite-plugin` and bundles only Node entries; `pkg.assets` includes `dist/client/**/*` and explicit server/native `node_modules/` paths, never `node_modules/solid-js` or `node_modules/@solidjs/*`).

## Bundle and Timing Measurements

Measured with the dashboard Vite client build (`vite.config.ts` only, while `free -m` showed > 4,800 MB available) and Vite dev server startup (`createServer` + `listen()`).

| Metric | Before | After | Delta |
|---|---:|---:|---:|
| Dashboard entry chunk (`assets/index-D1NIu5wH.js`) raw | 475,815 B | 475,815 B | 0 B |
| Dashboard entry chunk brotli | 133,451 B | 133,451 B | 0 B |
| Total client JS raw | 16,316,475 B | 16,316,475 B | 0 B |
| Total client JS brotli | 3,056,672 B | 3,056,672 B | 0 B |
| Total client CSS raw | 438,073 B | 438,073 B | 0 B |
| Total client CSS brotli | 68,891 B | 68,891 B | 0 B |
| Total client output raw | 18,587,775 B | 18,587,775 B | 0 B |
| Total client output brotli | 3,149,648 B | 3,149,648 B | 0 B |
| Standalone production island (`public/hello-island.tsx` + `solid-js` + `@solidjs/web`) raw | 0 B | 39,495 B | +39,495 B |
| Standalone production island brotli (quality 11) | 0 B | 11,778 B | +11,778 B |
| Dashboard client build total (Vite + brotli closeBundle) | 21,525 ms (9.04 s Vite, cold) | 6,237 ms (1.69 s Vite, warm) | -15,288 ms |
| Dev server start (`createServer` + `listen()`) | 2,336 ms | 1,628 ms | -708 ms |

Because `solid({ include: /\.tsx(?:\?|$)/ })` only transforms `.tsx` files (including Vite HMR `?t=` and `?v=` queries) and `public/hello-island.tsx` is not imported by `public/index.html`, the shipped dashboard entry chunk is byte-for-byte unchanged (0 B delta) until U2 adopts Solid components. The standalone production build of `public/hello-island.tsx` (39,495 B raw / 11,778 B brotli) was rendered in headless Chromium via Playwright and verified initial mount (`prod-hello`), reactive signal update (`prod-updated`), and `dispose()` cleanup.

## U1.1 Gate Extension and Planted `.tsx` Violation Results

Each extended gate was tested against a throwaway `.tsx` file under `public/`, observed failing, and the throwaway file was removed:

| Gate | Extended for `.tsx` | Planted violation result |
|---|---|---|
| `tests/gates/ui-primitives.test.ts` | yes | Failed on `<button>x</button>` in `public/__throwaway_gate_check.tsx` |
| `tests/gates/dom-selector-contract.test.ts` | yes | Failed on `queryTag(doc, '.nonexistent-tsx-selector', 'section')` |
| `tests/gates/no-tooltips.test.ts` | yes | Failed on `<span title="tip">x</span>` |
| `tests/gates/no-direct-iframe.test.ts` | yes | Failed on `<iframe src="about:blank" />` |
| `tests/gates/design-type-scale.test.ts` | yes | Failed on `<span class="text-xs">x</span>` |
| `tests/gates/unused-exports.test.ts` | yes (`MODULE_FILE`) | Failed on exported `__unusedThrowawayTsxExport` |
| `tests/gates/module-placement.test.ts` | yes | Failed on 5 `public/__zzcrowd-*.tsx` modules |
| `tests/gates/lint-gate.test.ts` | yes (via `biome.json`) | Failed on `noExplicitAny` in `.tsx` |
| `tests/gates/typecheck-gate.test.ts` | yes | Failed on `// forbidden comment` in `.tsx` |
| `tests/gates/flag-cluster-ratchet.test.ts` | yes | Failed on 3 boolean flags in `.tsx` |
| `tests/gates/session-card-options.test.ts` | yes | Failed on raw `createSessionCard(a, b, c, {})` in `.tsx` |
| `tests/gates/settings-registry.test.ts` | yes | Failed on `#settings/nonexistent-section/nonexistent-setting` in `.tsx` |
| `tests/gates/time-single-source.test.ts` | yes | Failed on `Date.now()` in `.tsx` |
| `tests/gates/no-glow.test.ts` | no (scans `.css`, `.html`, `.astro` only, not `.ts`) | n/a |
| `tests/gates/one-message-per-screen.test.ts` | no (checks `public/service-worker.ts` and `cloud/doorman/host-page.ts` only) | n/a |
| `tests/gates/ui-size-scale.test.ts` | no (scans `public/ui/*.css` and `public/style.css` only) | n/a |
| `tests/gates/chat-imports.test.ts` | already matched `.tsx` (`SOURCE_FILE`) | n/a |

## Root `AGENTS.md` Budget

- Retired line (251 bytes): the `Working In This Directory` bullet on PTY/ACP spawning through `pty-driver.ts`, `acp-driver.ts`, `child-process-safe.ts`, `shell: true`, and `spawn-env.ts`, which is already pinned by `tests/gates/no-direct-child-process.test.ts` and documented in `session/AGENTS.md` (`Key Files` and `Session Spawning`).
- Added line (135 bytes) in `## Dependencies`: `` `solid-js` and `@solidjs/web` provide the Solid 2 component model for dashboard islands (client-only; compiled by `@solidjs/vite-plugin`). ``
- Size: 9,979 bytes -> 9,854 bytes (budget: 10,000 bytes).
