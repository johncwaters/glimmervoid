<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-10 | Updated: 2026-06-10 -->

# sidebar

## Purpose
The review sidebar: the single home for the worktree review gate of the selected session. Opens on the Map view; the diff is the drill-down. Shows the actions (Merge into the integration branch without ending the session; Discard for a settled worktree). App-level, shared by every view. Right-docked on the desktop layout; the SAME element is re-parented into the phone Review screen (`reparentReviewPanel`), so both layouts are one review surface with one set of caches and listeners.

## Key Files

| File | Description |
|------|-------------|
| `review-sidebar.ts` | DOM module: summary, per-file collapsible diff markup, Merge/Discard actions |
| `change-map-core.ts` | Pure Change Map facts to view model projection |
| `change-map-view.ts` | Change Map DOM rendering and file drill-down controls |
| `diff-core.ts` | Pure unified-diff parser: `git diff` text -> file sections with hunks and typed lines; no DOM |
| `selection.ts` | Single source of truth for the selected session id, with subscriber notification; shared by grid clicks and Focus pill focusing |

## For AI Agents

### Working In This Directory
- Selection goes through `selection.ts` only; never track a competing "current session" elsewhere.
- `diff-core.ts` stays pure and dependency-free (node:test runs it); rendering belongs in `review-sidebar.ts`.
- Merge semantics live server-side (rebase-then-FF, park on conflict, `session/core/merge-prompt.ts` handoff); the sidebar only sends control messages and renders results.
- Diff text renders via textContent/escaped markup; never innerHTML raw diff content.
- The panel and header view tabs are built once and MOVED between layouts, never rebuilt, so drafts and listeners survive layout changes. Desktop minimizes to a status rail (`data-collapsed`, persisted in `ui-prefs.ts`); phone hides the minimize control and rail and ignores collapsed state.

### Testing Requirements
- `tests/frontend-diff-core.test.ts` for the parser; merge flow verified end-to-end via `npm run dev` with a worktree session.

## Dependencies

### Internal
- `../control-ws.ts` (merge/discard/diff requests), `../session-card/` (per-card merge state), `../app.ts` (merge shortcut, catalog in `../shortcuts-core.ts`)

<!-- MANUAL: Any manually added notes below this line are preserved on regeneration -->
