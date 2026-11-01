<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-09 | Updated: 2026-08-09 -->

# phone

## Purpose
The phone layout: the Board (labelled Focus, matching the desktop tab), Terminal and each view flagged `isPhoneNavScreen` behind a bottom nav, plus one More screen per other desktop tab, rendered ONLY under `[data-layout="phone"]`. The More screens are DERIVED from the desktop tab list (`phone-panels-core.ts`), never listed here, because a hand-kept second list can omit a desktop tab from the phone. It is a first-class layout, not a narrowed desktop: the desktop shell is `display:none` on a phone, and the phone shell borrows the elements that own live state instead of rebuilding them.

The job it serves is triage, per `brand-bible/strategy.yaml`: scan the board, find the session that needs a carbon unit, open it, act, go back.

## Key Files

| File | Description |
|------|-------------|
| `phone-shell.ts` | Owns the screen container, the bottom nav, screen switching, nested More screens, history integration, visual-viewport sizing, and the activate/deactivate handoff with the desktop layout |
| `phone-panels-core.ts` | Pure derivation of the More screens from the desktop tabs; Focus is left out because Board and Terminal serve it |
| `board-screen.ts` | The default screen: name-ordered project groups under the shared Needs you banner + the phone top bar (which adopts the desktop header's connection chip, "+ Session", help, and hamburger) |
| `terminal-screen.ts` | One session's full-bleed terminal: back control, name, state badge, the card's adopted action cluster, and the touch key strip |
| `mobile-key-strip.ts` | Sticky Ctrl / Esc / Tab / arrows / Paste / Attach, the keys and uploads a soft keyboard cannot produce (catalog in `../mobile-keys.ts`); shown whenever the Terminal screen is |

The More screens have no phone-only module: each screen is a mount container that re-parents the real desktop panel in.

## For AI Agents

### Working In This Directory
- Which layout runs is decided by `../form-factor-core.ts` (`coarse AND narrow`) and stamped on `<html data-layout>` by `../form-factor.ts`. Style phone surfaces off that attribute; never add a `max-width` override of a desktop selector.
- Re-parent, never duplicate. `dom-helpers.ts` `adoptElement` / `releaseElement` for panels; `../card-host.ts` `borrowCard` / `releaseCard` for a session card (single borrower GLOBALLY, shared with the Focus center).
- One state pipeline. The Board reads `session-card/card-registry` and is refreshed by the same `app.ts` control-WS handlers that refresh the desktop rail. Do not subscribe to the control WS from here.
- One "needs you" rule. The Board and the desktop rail head render the same `{n} NEED YOU` readout, so the predicate and the wording live once in `../focus-view/attention-core.ts`. Seen is server state: showing a session sends `dismiss` through `markSessionSeen`, so never keep a client-side seen flag here.
- Row clocks ride the shared tick (`session-card/session-tick.ts` `onSessionTick`), never a timer of their own.
- History: one entry per level above the Board (the screen, then a nested level such as a Settings section), reconciled by `syncPhoneHistory`, and only while the phone shell is active. A level without its own entry makes a mobile swipe-back (Safari, Chrome on Android) slide the page away and then redraw it, because the app has to intercept and re-push. Desktop must never touch history.
- Soft keyboard: the shell is sized from `window.visualViewport`, so the keyboard resizes the terminal instead of covering it; the card's existing ResizeObserver then refits cols/rows.
- Every function reachable on desktop must be reachable here or its absence justified. A desktop mechanism that has no touch meaning gets the correct touch-native one (inline rename retargets to the Terminal top bar's name via `ui.renameTargetEl`), never a dead affordance.
- `*-core.ts` files stay pure (no DOM, no window); they run under node:test too.

### Testing Requirements
- DOM behavior is verified manually; real-device rendering is not covered by the suite.

## Dependencies

### Internal
- `../form-factor.ts`, `../card-host.ts`, `../dom-helpers.ts`
- `../project-registry.ts`, `../session-actions.ts`, `../session-card/` (registry, tick, terminal input), `../focus-view/attention-core.ts` (the alphabetical order, shared with the rail), `../focus-view/roster-group-header.ts` and `../attention-banner.ts` (the project header and Needs you banner, shared with the rail), `../ui-prefs.ts`, `../control-ws.ts`

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
