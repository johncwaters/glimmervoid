<!-- Parent: ../AGENTS.md -->

# board-session

## Purpose
Studio: the board-first way to work with agents on a repo's code map. Chat is a separate surface; Studio never reuses Chat's log layout.

## Key Files

| File | Description |
|------|-------------|
| `board-session-view.ts` | The Studio tab: repo chip, freshness badge, trace watches per repo session, seated as a guest on the shared Boards host |
| `presence-layer.ts` / `presence-core.ts` | Faces on the boxes sessions work in, their working status and subagent faces |
| `dock.ts` | The message pill and the folded log of prompts and replies |

## Invariants

### Studio
- Studio shows a repo, never a picked session, and never follows Focus: the repo chip is the only way to change it.
- The browser names a repo by one of its live session ids, never by a path, because the server must resolve every path it acts on (trust boundary).
- Each repo has one main agent, marked by `isStudioMain` on its project entry in `shared/contracts/config.ts`; opening a repo ensures it (use, start, restart or create, decided in `server/core/studio-main-core.ts`), so Studio never opens blank.
- The log keeps prompts and replies only; tool, skill, subagent and workflow activity shows as faces on the board, never as log rows.
- Codemap elements are generated, so folder stacking changes only through `codemap-folder-toggle`, never by setting a frame's `collapsed`.
- Studio draws its map through the shared Boards host (`mountBoardHost`, `showBoardBeside` with a `BoardHostGuest`), never a canvas of its own, so every board behavior reaches Studio and Boards alike; new board behavior goes in `public/whiteboard/`.
