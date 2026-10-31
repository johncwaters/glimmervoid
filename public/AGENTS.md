<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-07-02 -->

# public

## Purpose
The browser dashboard frontend: ES modules bundled by Vite (dev server with HMR on 5173, production build to `dist/`). Renders session cards with xterm.js terminals, primary views including Settings, a review sidebar, dialogs, themes, and notifications. ANSI is parsed in the browser for display and in the server keeper for attach, because raw bytes are only correct at the width that produced them.

## Key Files

| File | Description |
|------|-------------|
| `index.html` | Dashboard shell (Tailwind utility classes) |
| `app.ts` | Boot entry: the store wiring and the connect tail, calling one `boot/` module per surface in dependency order |
| `control-ws.ts` | Control WebSocket client: connection, reconnect, request/response |
| `reconnect-backoff.ts` | Pure `nextReconnectDelayMs(attempt, random)`: the ONE retry delay for both WS clients (500ms doubling to a 30s cap, jittered to 50-100%) |
| `dialogs.ts` | Add Session and investigation-report dialog factories |
| `external-link.ts` / `external-link-core.ts` | THE opener for every off-dashboard link: inside an editor's Electron browser view it asks the host (`POST /open-external`) because that view keeps every popup as an internal tab |
| `github/pr-status-icon.ts` / `github/pr-status-icon-core.ts` | THE pull request status icon set (Octicons, crisp only at their native 16px) and its help-page legend; separate from the agent status icons in `status-icon.ts` |
| `signal.ts` / `signal-core.ts` | THE small status badge (icon, tone, text) for session rows and the Link pull request dialog's PR chips, plus the one ranking that keeps two per line by urgency tier and folds the rest into +N. A new badge kind is a Signal with a tier, never a new chip style |
| `menu.ts` | Menu item markup and arrow-key focus for the card's Session actions menu |
| `render-scheduler.ts` | Global xterm WRITE scheduler: callback-gated round-robin with per-frame budget |
| `notifications.ts` | Native Web Notifications (browser routes to Windows Action Center); replaces the server-side toast path |
| `notify-dedupe-core.ts` | Pure cross-tab claim (short-TTL localStorage) so exactly one open tab raises each notification |
| `alert-sound.ts` / `alert-sound-core.ts` | Alert sounds: synthesized built-ins plus the operator's own files from `GET /custom-sounds`; any id no longer present resolves to the default |
| `health-monitor.ts` | Footer panel rendering server memory/leak telemetry from `health-snapshot` messages |
| `hooks-panel.ts` / `hooks-view-core.ts` | Hooks tab: operator Claude Code hooks (`request-hooks-report`, `save-hook`, `delete-hook`) over a pure core owning every string and draft rule |
| `trace-panel.ts` / `trace-view-core.ts` | Trace tab: one session's recorded trace paged over `session-trace`, over a pure core owning turn grouping and row labels |
| `theme.ts` | Theme definitions applied as CSS custom properties; terminal theme derived at runtime |
| `ui-prefs.ts` / `local-store.ts` | THE localStorage home for UI state (sound, theme, active view, rail and sidebar widths), over quota-safe wrappers. Each key is declared once in `ui-prefs.ts`'s `PREFS` table with its default and normalizer; the accessors are one line each. The review sidebar's width keeps its own storage key so an existing install's saved width survives |
| `shortcuts-core.ts` | Pure catalog of dashboard shortcuts matched by `KeyboardEvent.code` under Cmd (Mac) or Alt, plus the help list groups; `boot/shortcuts-dispatch.ts`, the xterm pass-through and the help list all read it |
| `shortcuts.ts` | DOM shell for `shortcuts-core.ts`: platform detection from the user agent, `kbd` chord rendering |
| `form-factor-core.ts` | Pure `decideLayout({ coarse, narrowWidth })` -> `'phone' \| 'desktop'`: the one predicate choosing between the two first-class layouts |
| `form-factor.ts` | Its IO shell: evaluates the two media queries, stamps `<html data-layout>`, notifies subscribers on a live flip |
| `card-host.ts` | THE session-card re-parenting seam (`borrowCard` / `releaseCard`), single borrower GLOBALLY; shared by the Focus center and the phone Terminal screen |
| `project-registry.ts` | Project grouping registry shared by the desktop roster and phone Board |
| `session-actions.ts` | Shared session action entry points for dashboard surfaces |
| `dom-helpers.ts` | `el()` DOM utility, `adoptElement()` / `releaseElement()` (move a live element and put it back), and the chrome the tab panels share: `buildPanelSection()` / `buildStatChip()` (class prefix parameterized, so the per-panel CSS is unchanged), `projectsOf()` and `isPanelHidden()` |
| `style.css` | Component styles, `[data-state]` rules, animations, `::before` pseudo-elements |
| `tailwind.css` | Tailwind v4 entry: `@theme` block mapping colors, fonts, radii |
| `perf.html` / `perf-harness.ts` / `perf-corpus.ts` | Dev-only manual perf harness (K xterm terminals under dense ANSI load); never bundled into production |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `boot/` | The boot surfaces, called from `app.ts` in this order: connection screen, session frames, message dispatch, banners, header controls, hash routes, header trays, view tabs, layout switch, power menu, shortcut dispatch, viewer focus, client errors; plus `handlers/` (one control message handler group per surface, merged by the pure `boot/core/message-dispatch-core.ts`, which refuses a type two groups claim; the dispatch gate reads both wire ends the same way) |
| `session-card/` | Session card modules: terminal, lifecycle, DOM, naming, WebGL pool (see `session-card/AGENTS.md`) |
| `focus-view/` | Focus view: roster rail + centered card, attention queue (see `focus-view/AGENTS.md`) |
| `phone/` | Phone layout: the Board (labelled Focus) and Terminal behind a bottom nav, plus one More screen per desktop tab, rendered only under `[data-layout="phone"]` (see `phone/AGENTS.md`) |
| `plan/` | Safe plan parsing and the session card's shared plan face (see `plan/AGENTS.md`) |
| `sidebar/` | Review sidebar: diff rendering, selection, merge actions (see `sidebar/AGENTS.md`) |
| `usage/` | Usage tab: the DOM shell and its pure formatting core |
| `github/` | GitHub views: issues, my PRs, team review, the PR queue and status icons, and the shared polling retry text |
| `settings/` | Settings view: the DOM shell over the shared registry, pure search, hash, draft and phone-screen rules, and `settings-link.ts`, the one builder for `#settings/` and `#settings?q=` links |
| `radar/` | Radar panel: the DOM shell, its pure view core and the hold rules |
| `components/` | Static HTML fragments imported `?raw` (see `components/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- ESM only (this is the Vite side; the server is CJS), and every file under `public/` is `.ts`, checked strict by `tsconfig.public.json`. A `*-core` module is PURE (no DOM) and shared with node:test, so it runs under Node type stripping: keep it erasable, dependency-free, and give every relative import an explicit `.ts` extension.
- CSS convention: Tailwind utilities in `index.html`; semantic classes in `style.css` for JS-created DOM; state-driven styles via `[data-state]`; keyframes and pseudo-elements in `style.css`; theme tokens in `tailwind.css`.
- TWO first-class layouts, chosen by `form-factor-core.ts` and stamped on `<html data-layout>`. Phone styling keys off `[data-layout="phone"]`, never a `max-width` override of a desktop selector; a bare `max-width` block is only for content that must wrap in a narrow DESKTOP window. Neither layout duplicates the other's DOM: elements owning live state are re-parented (`adoptElement` / `card-host.ts`).
- All terminal writes go through `render-scheduler.ts`; never call `term.write` with unbounded data outside it.
- Use `id` (stable UUID) for any session keying; `name` is display only.
- New persistent UI state goes through `ui-prefs.ts`, not raw localStorage: add a key to its `PREFS` table and a one-line accessor pair, never a second load/mutate/save copy.
- A confirm prompt comes from `session-card/modal.ts` `openConfirmDialog`, never a hand-rolled overlay.
- Section heads, stat chips, `projectsOf` and `isPanelHidden` come from `dom-helpers.ts`; a new tab panel passes its class prefix rather than copying the builders.

### Testing Requirements
- DOM modules are verified manually via `npm run dev`.

### Common Patterns
- Pure-core (`*-core`) + DOM-wrapper pairs, mirroring the server's seam pattern.
- Control messages via `sendControlMsg` / `sendControlRequest`; state pushed from the server as snapshots and events.

## Dependencies

### Internal
- `#shared/*.ts` (the package imports map in `package.json`): shared modules imported directly and bundled by Vite; there is no generated twin
- `server/backend/backend.ts` - the WS endpoints this client speaks to

### External
- `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl` - bundled by Vite, browser only
- `tailwindcss` v4 via `@tailwindcss/vite`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Dashboard Layouts

- Two first-class layouts, not one responsive shell. `decideLayout` needs a coarse pointer AND a narrow viewport: a narrowed desktop window keeps the three-panel IA, and a coarse-pointer tablet has room for it. All phone styling keys off `[data-layout="phone"]`.
- Nothing is duplicated; live elements are RE-PARENTED into the phone screens and back, a second copy meaning a second state pipeline for the same facts. The card-borrow seam holds a GLOBAL single borrower, a session owning one xterm.
- The Board and the rail share name order, the project group header (`public/focus-view/roster-group-header.ts`) and the Needs you banner (`public/attention-banner.ts`), one source each so the two cannot drift. The "needs you" RULE lives once, in `public/focus-view/attention-core.ts`.
- Touch scroll is ours because xterm 6.0.0 has no touch path at all. The alternate buffer re-emits the drag as synthetic wheel notches so xterm's OWN listeners decide the meaning.
- Predictive text bypasses xterm's input path on PHONE ONLY: xterm 6.0.0 mishandles autocorrect events (upstream `xtermjs/xterm.js#3600`, open). Desktop is untouched, where the same takeover would regress CJK composition.

## CSS Convention

- Tailwind utility classes for static markup in `index.html`; semantic classes in `style.css` for JS-created DOM.
- State-driven styles via `[data-state]` selectors; layout branches via `[data-layout]`.
- Animations and pseudo-elements live in `style.css`; theme tokens in `public/tailwind.css` via `@theme`, applied by `public/theme.ts`.
