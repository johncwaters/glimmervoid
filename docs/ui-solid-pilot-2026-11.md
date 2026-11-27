# Solid 2 Pilot Report (2026-11-26)

Measured on `johncwaters/glimmervoid` `main` (`045940664`, Node `v22.23.5`, Vite `8.3.8`, Playwright `1.65.1`, Chromium `159.0.8154.6`) for Q3 (Solid 2 pilot go or no-go). Covers U2.1 (`699bc7b88`, `1f31e8ac7`, `efbf53dba`, `a1e6f7788`), U2.2 (`28b81a9cd`), and U2.3 (`35a1cc8ab`).

**Recommendation: GO for U3** (after realignment Phase 3 lands Studio on ACP, per plan Decision 8).

---

## 1. Lines Before and After (U2.1 to U2.3)

Counted from git (`git show <before-ref>:<path> | wc -l` vs `git show main:<path> | wc -l`, where `<before-ref>` is `699bc7b88^` for U2.1/tests/harness, `28b81a9cd^` for U2.2, and `35a1cc8ab^` for U2.3).

### U2.1 Primitives (`public/ui/`, `699bc7b88^` vs `main`)

| Primitive | Before (`.ts`) | Pure Core (`-core.ts`) | Imperative Shell (`.ts`) | Solid 2 (`.tsx`) | Net Delta (Dual-Shell) | After Shell Retirement (`core + tsx`) |
|---|---:|---:|---:|---:|---:|---:|
| `pressable` | 12 | 25 | 16 | 24 | +53 | 49 |
| `button` | 98 | 98 | 96 | 178 | +274 | 276 |
| `text-input` | 59 | 91 | 63 | 136 | +231 | 227 |
| `field` | 76 | 77 | 74 | 125 | +200 | 202 |
| `checkbox` | 66 | 47 | 82 | 122 | +185 | 169 |
| `switch` | 21 | 28 | 28 | 33 | +68 | 61 |
| `select` | 56 | 64 | 63 | 76 | +147 | 140 |
| `segmented` | 80 | 70 | 86 | 86 | +162 | 156 |
| `disclosure` | 55 | 40 | 57 | 72 | +114 | 112 |
| `tag` | 17 | 24 | 17 | 28 | +52 | 52 |
| `keycap` | 19 | 29 | 22 | 40 | +72 | 69 |
| `meter` | 53 | 71 | 50 | 62 | +130 | 133 |
| `notice` | 89 | 99 | 101 | 122 | +233 | 221 |
| `empty-state` | 31 | 30 | 35 | 50 | +84 | 80 |
| `section-heading` | 42 | 47 | 39 | 47 | +91 | 94 |
| `copy-button` | 76 | 44 | 75 | 94 | +137 | 138 |
| **U2.1 Subtotal (16 primitives)** | **850** | **884** | **904** | **1,295** | **+2,233** | **2,179** |

### U2.2 Dialog (`28b81a9cd^` vs `main`) and U2.3 Popup Menu (`35a1cc8ab^` vs `main`)

| Module / File | Role | Before | After | Delta |
|---|---|---:|---:|---:|
| `public/ui/dialog-core.ts` | Pure core | 0 | 121 | +121 |
| `public/session-card/modal.ts` | Imperative shell | 197 | 187 | -10 |
| `public/ui/Dialog.tsx` | Solid 2 component | 0 | 182 | +182 |
| `public/ui/modal-state.ts` | Shared modal inert state | 10 | 29 | +19 |
| `public/dialogs.css` | Stylesheet | 585 | 605 | +20 |
| `public/ui/popup-menu-core.ts` | Pure core | 0 | 121 | +121 |
| `public/ui/popup-menu.ts` | Imperative shell | 133 | 179 | +46 |
| `public/ui/PopupMenu.tsx` | Solid 2 component | 0 | 275 | +275 |

### Totals by Layer (18 Pilot UI Modules + Tests and Harness)

| Category | Before | After | Delta |
|---|---:|---:|---:|
| Pure cores (`*-core.ts`, 18 files) | 0 | 1,126 | +1,126 |
| Imperative shells (`public/ui/*.ts` + `public/session-card/modal.ts`, 18 files) | 1,180 | 1,270 | +90 |
| Solid 2 components (`public/ui/*.tsx`, 18 files) | 0 | 1,752 | +1,752 |
| **Pilot UI modules subtotal** | **1,180** | **4,148** | **+2,968** |
| Supporting UI files (`modal-state.ts`, `dialogs.css`) | 595 | 634 | +39 |
| Node tests and gates (`tests/ui-primitives-core.test.ts`, `tests/gates/ui-primitives.test.ts`) | 288 | 856 | +568 |
| Browser harness (`ui-primitives-parity.ts`, `confirm-dialog.ts`, `cases-core.ts`, `runner.ts`) | 2,396 | 3,855 | +1,459 |
| **Tests and harness subtotal** | **2,684** | **4,711** | **+2,027** |

Note: `harness/browser/confirm-dialog.ts` grew from `402` lines in U2.2 (`28b81a9cd`) to `464` lines on `main` after `9cf00efcd` added Escape-guard regressions (`+62` lines). Dual-shell coexistence adds `1,270` lines of imperative wrappers that U3.2 retires as call sites convert.

---

## 2. Dashboard Bundle Change (Pre-U1.1 vs `main`)

Measured with Vite client builds (`vite.config.ts` only, never `npm run build` in the main checkout) into `/tmp/u24-bundle-meas` at `0db1fb381` (`1de48485d^`, before U1.1) and `main` (`045940664`). Sizes computed with Node `zlib.gzipSync(..., { level: 9 })` and `.br` files / `zlib.brotliCompressSync` (quality 11).

Command:

```bash
./node_modules/.bin/vite build --outDir /tmp/u24-bundle-meas/dist-pre-u11  # at 0db1fb381
./node_modules/.bin/vite build --outDir /tmp/u24-bundle-meas/dist-main     # at main (045940664)
```

| Metric | Pre-U1.1 (`0db1fb381`) | `main` (`045940664`) | Delta |
|---|---:|---:|---:|
| Dashboard entry chunk (`assets/index-*.js`) raw | 475,815 B | 476,627 B | +812 B (+0.17%) |
| Dashboard entry chunk gzip (level 9) | 156,535 B | 156,806 B | +271 B (+0.17%) |
| Dashboard entry chunk brotli (quality 11) | 133,236 B | 133,608 B | +372 B (+0.28%) |
| Total client JS raw (499 -> 500 files) | 16,334,801 B | 16,375,956 B | +41,155 B (+0.25%) |
| Total client JS gzip | 3,643,837 B | 3,664,600 B | +20,763 B (+0.57%) |
| Total client JS brotli | 3,063,395 B | 3,083,031 B | +19,636 B (+0.64%) |
| Total client CSS raw (18 -> 18 files) | 438,073 B | 438,360 B | +287 B (+0.07%) |
| Total client CSS gzip | 82,533 B | 82,588 B | +55 B (+0.07%) |
| Total client CSS brotli | 69,065 B | 69,104 B | +39 B (+0.06%) |
| Total client output raw (634 -> 635 files) | 18,704,353 B | 18,647,952 B | -56,401 B (-0.30%) |
| Total client output gzip | 5,356,816 B | 5,376,560 B | +19,744 B (+0.37%) |
| Total client output brotli | 4,699,999 B | 4,719,220 B | +19,221 B (+0.41%) |

Note: total output raw dropped by 56 KB due to non-JS/CSS asset churn between `0db1fb381` and `045940664`. The shipped JS delta (`+41,155 B` raw / `+19,636 B` brotli) comes from U2.2 statically importing `public/ui/Dialog.tsx` (and Solid 2 runtime + `Button.tsx` + `Pressable.tsx` + `island.ts`) from `public/session-card/modal.ts` into a shared chunk, leaving the entry chunk nearly flat (`+812 B` raw).

### Standalone Island Costs (Reported by U0.1 and U2 Children)

| Island | Raw | Gzip (level 9) | Brotli (quality 11) | Shipped in Dashboard Entry Today | Source |
|---|---:|---:|---:|---|---|
| U0.1 `hello-island.tsx` (`solid-js` + `@solidjs/web` floor) | 39,495 B | not recorded | 11,778 B | No (throwaway) | `docs/ui-solid-check-2026-11.md:41-42` |
| U2.1 16 primitives (`public/ui/*.tsx`) | n/a | n/a | n/a | Only `Button.tsx` + `Pressable.tsx` via U2.2 | `699bc7b88`..`a1e6f7788` |
| U2.2 `Dialog.tsx` + runtime via `modal.ts` | +41,155 B | +20,763 B | +19,636 B | Yes (shared chunk) | Measured above (`28b81a9cd`) |
| U2.3 `PopupMenu.tsx` standalone production island | 71,724 B | 22,378 B | 20,178 B | No (`0 B` shipped delta) | Standalone Vite 8.3.8 build on `35a1cc8ab` |

---

## 3. Browser Harness Run Time Change

Measured on the same host with Chromium `159.0.8154.6`. Pre-pilot baseline ran from `git archive 699bc7b88^` in `/tmp/u24-harness-before` with symlinked `node_modules`.

Commands:

```bash
# On main (045940664):
npm run test:browser -- --only ui-primitives-parity --only confirm-dialog --only boards --only board-pane --only board-session

# Pre-pilot baseline (699bc7b88^ in /tmp/u24-harness-before):
node harness/browser/harness.ts --artifacts /tmp/u24-harness-before/artifacts --only boards --only board-pane --only board-session
```

### Cases Added or Touched by U2.1 to U2.3 (`main`)

| Viewport | Case | Added / Touched By | `main` Run Time | Result |
|---|---|---|---:|---|
| `phone-393` | `ui-primitives-parity` | U2.1, U2.3 | 1,211 ms | PASS |
| `desktop-1280` | `ui-primitives-parity` | U2.1, U2.3 | 1,350 ms | PASS |
| `phone-393` | `confirm-dialog` | U2.2, `9cf00efcd` | 982 ms | PASS |
| `desktop-1280` | `confirm-dialog` | U2.2, `9cf00efcd` | 1,432 ms | PASS |
| **Added cases subtotal (4 cases)** | | | **4,975 ms** | **4/4 PASS** |

### Pre-Existing Confirm / Popup Cases (Before vs After)

| Viewport | Case | Before (`699bc7b88^`) | After (`main`) | Delta |
|---|---|---:|---:|---:|
| `phone-393` | `boards` | 4,139 ms | 4,329 ms | +190 ms (+4.6%) |
| `desktop-1280` | `board-pane` | 22,910 ms | 24,482 ms | +1,572 ms (+6.9%) |
| `desktop-1280` | `board-session` | 114,956 ms | 115,166 ms | +210 ms (+0.2%) |
| `desktop-1920` | `boards` | 31,032 ms | 29,934 ms | -1,098 ms (-3.5%) |
| **Pre-existing subtotal (4 cases)** | | **173,037 ms** | **173,911 ms** | **+874 ms (+0.5%)** |
| **Harness wall time** | | **174.4 s (4 cases)** | **180.0 s (8 cases)** | **+5.6 s** |

Pre-existing cases show no measurable regression (`+0.5%`, within run-to-run variance); all 4 new pilot cases combined add 5.0 s.

---

## 4. Solid 2 Surprises and U1.3 Convention Bends

Every item from the U2.1 (`699bc7b88`..`a1e6f7788`), U2.2 (`28b81a9cd`), and U2.3 (`35a1cc8ab`) pilot notes was checked against `main`.

### Solid 2 and Platform Surprises

| # | Surprise | Verified In Code | Pattern / Fix |
|---|---|---|---|
| 1 | `createEffect` never compares return values; reading a whole `descriptor()` memo over-subscribes to unrelated props (`meta`, `command`) | `public/ui/Notice.tsx:59,92`, `public/ui/CopyButton.tsx:59-62` | Read narrow prop accessors directly in `createEffect` compute fn; wrap `statusResetKey` in `createMemo` |
| 2 | Lazy JSX factory inside `createMemo` loses reactivity when the memo re-runs (disposes child computations, returns dead DOM node) | `public/ui/Disclosure.tsx:29-40,59` | Gate lazy body behind a monotonic boolean memo (`isBodyActivated`) that flips `false -> true` once |
| 3 | `JSX.Element` includes `boolean` and `''`, so `actions != null` renders empty wrappers for `cond && <Button />` | `public/ui/EmptyState.tsx:15-22`, `public/ui/SectionHeading.tsx:16-29`, `public/ui/Notice.tsx:28-36` | Filter with `hasRenderableActions` (rejects booleans, empty strings, and empty arrays) |
| 4 | `onSettled` cleanup only cancels an already-scheduled timer, missing disposal while an async clipboard Promise is in flight | `public/ui/CopyButton.tsx:32,41,54-56` | Use `onCleanup` to cancel timers and bump a generation counter (`latestCopy`) |
| 5 | Biome JSX a11y rules (`useAriaPropsSupportedByRole`, `useSemanticElements`) reject `<span role="meter">` needed for DOM/CSS parity | `public/ui/Meter.tsx:24-26` | Apply `role`, `aria-label`, and `--meter-value` via `ref` + split `createEffect` (zero lint suppressions) |
| 6 | `tests/gates/unused-exports.test.ts` scans git-tracked files only, so untracked `*-core.ts` exports slip past `check:fast` until staged | `tests/gates/unused-exports.test.ts:19` | Run `git add -N .` before `npm run check:fast` |
| 7 | Calling `onCleanup` inside a `ref` callback throws `CLEANUP_IN_FORBIDDEN_SCOPE` at runtime in Solid 2 | `public/ui/Dialog.tsx:117` | Register `onCleanup` at the top level of the component body, cleaning up the captured `dialogElement` ref |
| 8 | First static `.tsx` import from `public/**/*.ts` (`modal.ts` -> `Dialog.tsx`) broke `tsconfig.browser-harness.json` (`TS6142`) | `tsconfig.browser-harness.json:11-12` | Added `"jsx": "preserve"` and `"jsxImportSource": "@solidjs/web"` to `tsconfig.browser-harness.json` |
| 9 | Coexisting top-layer `<dialog>.showModal()` and legacy `z-index: 200` overlays fought over background inertness and Escape listeners | `public/ui/modal-state.ts:14-16`, `public/ui/Dialog.tsx:76,139` | Moved `syncModalInert` to `modal-state.ts` (skips inerting when native `<dialog>` is topmost); `9cf00efcd` also added `isModalOpen()` guards to `public/board-session/studio-diff-panel.ts:6,75` and sibling Escape handlers |
| 10 | Popover API `toggle` fires asynchronously while `beforetoggle` is sync; author `.popup-menu { display: flex }` overrides UA `[popover]:not(:popover-open)` hiding | `public/ui/PopupMenu.tsx:1,194-214` | Sync `hidden`, `aria-expanded`, and `data-state` in `beforetoggle` with Solid `flush()` |
| 11 | `@solidjs/web` JSX types omit `popover` / `popovertarget`; invoking `onSelect()` before closing popover steals focus from opened modals | `public/ui/PopupMenu.tsx:115-116,144-145,167-188` | Set `popover`/`popovertarget` via `ref` + split `createEffect`; call `closePopover` before `onSelect()` and `stopPropagation()` on Escape |

### U1.3 Conventions (`public/AGENTS.md:71-77`, `public/ui/island.ts`)

| Convention | Held or Bent | Verified Details |
|---|---|---|
| One function per `.tsx` file | **Bent (5 files)** | Multi-export primitives keep tightly coupled variants in one file to preserve 1:1:1 mapping with `.ts` shells: `Button.tsx` (4 exports), `TextInput.tsx` (2), `Checkbox.tsx` (2), `Disclosure.tsx` (2), `Keycap.tsx` (2) |
| Pure core beside every component (`*-core.ts`) | **Held** | All 18 pilot modules follow `*-core.ts` + shell + `.tsx`; all 18 cores run under `node:test` (`tests/ui-primitives-core.test.ts`, 26/26 passing across 18 suites) |
| No inline `style=` in `.tsx` | **Held (workaround)** | `Meter.tsx:24` sets CSS custom property `--meter-value` via `element.style.setProperty` inside `ref` + `createEffect` instead of a JSX `style=` attribute |
| No `control-ws.ts` imports in `.tsx` (`state-tsx-imports.test.ts`) | **Held** | `Notice.tsx:25,59-60` exposes an optional `onShown` callback prop while imperative `notice.ts` keeps calling `reportNoticeShown` |
| No `title=` outside `pressable.ts` (`no-tooltips.test.ts`) | **Held** | `Pressable.tsx` has zero `title` references; `pressable.ts` keeps the sole allowed `title` line |
| Mount and dispose via `public/ui/island.ts` | **Held** | Worked unchanged across `Dialog.tsx`, `PopupMenu.tsx`, and all 16 primitives in `ui-primitives-parity` (`pending -> connected -> disposed`) |

---

## 5. Ark UI Compatibility and U4 Wait Criteria

U2.3 tested both published `@ark-ui/solid` channels against `solid-js@2.0.4`, `@solidjs/web@2.0.4`, and `@solidjs/vite-plugin@3.0.1` (then uninstalled both cleanly; `package.json` and `package-lock.json` are untouched):

| Channel | Version | `@zag-js/solid` | Vite 8.3.8 Build | Failure Cause |
|---|---|---|---|---|
| `latest` | `5.40.1` | `1.49.0` | Failed in 245 ms | `[rolldown:vite-resolve] "./web" is not exported` from `solid-js` |
| `next` | `6.0.0-next.0` | `2.0.0-next.3` | Failed in 470 ms | Identical `"./web" is not exported` failure |

**Why both fail on Solid 2:**
- Both channels advertise loose semver peer ranges (`"solid-js": ">=1.6.0"` / `">=1.1.3"`), which fooled `npm view` in U0.1, while their built `dist/` files still target Solid 1.x.
- `@ark-ui/solid` imports `createComponent`, `mergeProps`, `memo`, and `Portal` from `solid-js/web` (removed in Solid 2 in favor of `@solidjs/web`), plus `splitProps`, `onMount`, `on`, and `Index` from `solid-js` (all `undefined` in `2.0.4`), and types `JSX` from `'solid-js'`.
- `@zag-js/solid` imports `mergeProps`/`onMount` from `solid-js`, uses 1-arg `createEffect`, and pulls `@solid-primitives/keyed@^1.5.3` (peer `"solid-js": "^1.6.12"`), triggering npm `ERESOLVE`.

**What U4 must wait for and how to recheck:**
- Wait for explicit Solid 2 releases of **both** `@zag-js/solid` and `@ark-ui/solid` whose `peerDependencies` declare `@solidjs/web` and `solid-js` `^2.0.0` (with no `@solid-primitives/keyed` 1.x peer conflict).
- Recheck command (never trust `npm view` peer ranges alone):

```bash
npm view @ark-ui/solid peerDependencies --json && npm view @zag-js/solid peerDependencies --json
```

Followed by a scratch `vite build` of a minimal `<Menu.Root>` island against the repo's installed `solid-js` and `@solidjs/web` before asking Q4 or adding the dependency.

---

## 6. Known Gaps

- **`phone-remove-returns-to-focus` (`phone-393`) fails on `main` (`045940664`):** times out after ~32 s waiting for `.phone-board-list button[data-action="confirm-remove-session"]:visible` (`harness/browser/runner.ts:73,884`) after opening the session menu and clicking Remove.
- **Bisect status (dispatcher runs, 2026-11-26):** fails identically on every commit checked back to `3c483f3ed` (`2026-11-25 22:49`), before U1.1 (`1de48485d`) and the entire Solid 2 pilot (`699bc7b88`..`35a1cc8ab`). Tracked separately as task F21; not a Solid 2 pilot regression.

---

## 7. Recommendation for U3 (Q3)

**GO** for U3 once realignment Phase 3 lands Studio on ACP.

### Why GO

1. **Negligible bundle impact:** shipping Solid 2 + `Dialog.tsx` into the live dashboard added `+812 B` raw (`+372 B` brotli) to the entry chunk and `+41,155 B` raw (`+0.25%`; `+19,636 B` / `+0.64%` brotli) to total client JS.
2. **No harness slowdown:** pre-existing confirm/popup cases stayed within `+0.5%` noise; 4 new desktop + phone pilot cases add only `5.0 s`.
3. **Zero caller breakage:** 16 primitives, `openConfirmDialog` (19 callers), and `popupMenu` (6 callers) kept byte-for-byte DOM and API parity with zero caller edits.
4. **No Ark UI blocker:** native `<dialog>.showModal()` and Popover API covered top-layer, focus trap, Escape, and light dismiss cleanly; U3 does not need Ark UI.
5. **Solid 2 sharp edges are mapped and gated:** `solid-2-only.test.ts` catches 1.x APIs, `island.ts` handles disposal cleanly, and all 11 pilot surprises have established patterns.
6. **Line growth is transitional:** the `+2,968` pilot UI lines include `1,270` lines of imperative shells kept for coexistence; U3.2 deletes imperative views and shells as callers move.

### What a GO Starts With

1. **U3.1 rule:** add to `public/board-session/AGENTS.md` that every new view under `public/board-session/` is a `.tsx` island following U1.3 conventions. When U3.3 updates `public/AGENTS.md`, note that tightly coupled primitive variants (such as `Checkbox`/`Radio`) may share one `.tsx` file.
2. **U3.2 conversion queue** (one task at a time, deleting the imperative view in the same change, and retiring each primitive's imperative shell once its last imperative caller is gone):
   1. Studio message bar and log: `public/board-session/dock.ts` (903 lines, after realignment P3.2 removes terminal fallbacks)
   2. Studio agent cards and waits: `public/board-session/agent-card.ts`, `public/board-session/agent-waits.ts`
   3. Chat composer, status rail, and model picker: `public/chat/composer.ts`, `status-rail.ts`, `model-picker.ts` (not `chat-feed.ts`)
   4. Add Session picker: `public/add-session/add-session-picker.ts` (1,113 lines)
   5. Settings: `public/settings/`
   6. Session card and Focus rail: `public/session-card/`, `public/focus-view/focus-view.ts`
