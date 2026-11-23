<!-- Parent: ../AGENTS.md -->

# board-session

## Purpose
Studio: the board-first way to work with agents on a repo's code map. Chat is a separate surface; Studio never reuses Chat's log layout.

## Key Files

| File | Description |
|------|-------------|
| `board-session-view.ts` | The Studio tab: repo chip, trace watches per repo session, seated as a guest on the shared Boards host |
| `presence-layer.ts` / `presence-core.ts` | Glows on the boxes sessions read, name and edit |
| `agent-card.ts` | One card per Studio agent beside its box (screen space, never on the board), with Chat's activity line, its digest and its menu; an idle branch folds to its face |
| `agent-waits.ts` | Chat's waits (questions, permissions, sign-in, limits) run per agent card |
| `dock.ts` | The message bar (Chat's composer) and the folded log of prompts and replies |

## Invariants

### Studio
- Studio is its own place, not a view of Focus: its sessions (a repo's main, marked `isStudioMain`, and its branches, marked `branchOf`; `isStudioSession` in `studio-target.ts`) never show in Focus rows, and Focus sessions never show in Studio, because the operator found one shared pool confusing. Studio reuses shared components (board host, add-session picker, status icon) rather than copying them.
- Studio shows a repo, never a picked session: the repo chip changes it, and opening a Studio session from elsewhere opens Studio on its repo.
- Studio sessions stay out of Focus's attention tally as well as its rows, so the tab title and phone dot never count a session no list shows.
- The browser names a repo by its main's session id, and a new repo only through `add-session` with `studio`, never by a bare path, because the server must resolve every path it acts on (trust boundary).
- Studio's repos are exactly the repos with a main; `add-session` with `studio` wakes or creates it (use, start, restart or create, decided in `server/core/studio-main-core.ts`), so a repo never gets two mains.
- Studio agent behavior lives in `mcp/core/studio-playbook.ts`, one entry per behavior and role, so changing how Studio agents work is editing an entry there, never adding prose to other instructions.
- The log keeps prompts and replies only; tool, skill, subagent and workflow activity shows on agent cards and box glows, never as log rows.
- Codemap elements are generated, so folder stacking changes only through `codemap-folder-toggle`, never by setting a frame's `collapsed`.
- Studio draws its map through the shared Boards host (`mountBoardHost`, `showBoardBeside` with a `BoardHostGuest`), never a canvas of its own, so every board behavior reaches Studio and Boards alike; new board behavior goes in `public/whiteboard/`.
- The open log's background stays slightly translucent: Chrome treats an opaque scroller's scrolled-off rows as covering the board canvas, which then stops drawing above the log.
