<!-- Parent: ../AGENTS.md -->

# board-session

## Purpose
Studio: the board-first way to work with agents on a repo's code map. Chat is a separate surface; Studio never reuses Chat's log layout.

## Key Files

| File | Description |
|------|-------------|
| `board-session-view.ts` | The Studio tab: repo chip, trace watches per repo session, seated as a guest on the shared Boards host |
| `presence-layer.ts` / `presence-core.ts` | Glows on the boxes sessions read, name and edit |
| `agent-card.ts` | One card per Studio agent beside its box (screen space, never on the board), with Chat's activity line (the Orchestrator's is the last line of the chat log instead), its digest and its menu; an idle branch folds to its face |
| `agent-waits.ts` | Chat's waits (questions, permissions, sign-in, limits) run per agent card |
| `dock.ts` | The message bar (Chat's composer) and the folded log of prompts and replies |

## Invariants

### Studio
- Studio is its own place, not a view of Focus: its sessions (the one Orchestrator, marked `isStudioMain`, and its branches, marked by a `parent` link with a box; `isStudioSession` in `studio-target.ts`) never show in Focus rows, and Focus sessions never show in Studio, because the operator found one shared pool confusing. Studio reuses shared components (board host, add-session picker, status icon) rather than copying them.
- Studio shows every Studio repo at once on the one map board, each in its own area: there is no repo to pick, and the Orchestrator's card, which belongs to no repo, stays fixed while the map pans.
- An area with no branch folds to its repo card. The board's own stack click opens it as a peek (`codemap-folder-set` on the area frame), and a peek ending never folds an area that has a branch.
- Studio sessions stay out of Focus's attention tally as well as its rows, so the tab title and phone dot never count a session no list shows.
- The browser names a repo only by a box on its area, and a new repo only through `add-session` with `studio`, never by a bare path, because the server must resolve every path it acts on (trust boundary).
- Studio's repos are the stored Studio repo list, one map area each; `add-session` with `studio` adds the repo and wakes or creates the one Orchestrator (decided in `server/core/studio-main-core.ts`). It runs in a Studio home outside every repo, so a sandboxed Orchestrator reads every repo and can write none.
- Studio agent behavior lives in `mcp/core/studio-playbook.ts`, one entry per behavior and role, so changing how Studio agents work is editing an entry there, never adding prose to other instructions.
- Whether a branch's work is safely elsewhere is `isBranchWorkElsewhere` in `server/board-session/branch-merge.ts`, the one place that changes when branches land on the integration branch instead of the Orchestrator's; self-close and the close refusal both read it.
- The log keeps prompts and replies only; tool, skill, subagent and workflow activity shows on branch cards, box glows and the Orchestrator's one activity line closing the log, never as log rows.
- The log keeps its compact height: answers belong on the board (the board-first playbook entry) and the director trims what reaches chat, because a log that grows covers the map the operator works on.
- Codemap elements are generated, so folder stacking changes only through `codemap-folder-set`, never by setting a frame's `collapsed`.
- Studio draws its map through the shared Boards host (`mountBoardHost`, `showBoardBeside` with a `BoardHostGuest`), never a canvas of its own, so every board behavior reaches Studio and Boards alike; new board behavior goes in `public/whiteboard/`.
- The open log's background stays slightly translucent: Chrome treats an opaque scroller's scrolled-off rows as covering the board canvas, which then stops drawing above the log.
