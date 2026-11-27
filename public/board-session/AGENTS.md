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
| `agent-waits.ts` | Chat's waits (questions, permissions, limits, and non-terminal sign-in notices) run per agent card |
| `dock.ts` | The message bar (Chat's composer) and the folded log of prompts and replies |

## Invariants

### Studio
- Studio is its own place, not a view of Focus: its sessions (the one Orchestrator, marked `isStudioMain`, and its branches, marked by a `parent` link with a box; `isStudioSession` in `studio-target.ts`) never show in Focus rows, and Focus sessions never show in Studio, because the operator found one shared pool confusing. Studio reuses shared components (board host, add-session picker, status icon) rather than copying them.
- Studio shows every Studio repo at once on the one map board, each in its own area: there is no repo to pick, and the Orchestrator's card, which belongs to no repo, stays fixed while the map pans.
- An area with no branch folds to its repo card. The board's own stack click opens it as a peek (`codemap-folder-set` on the area frame), and a peek ending never folds an area that has a branch.
- Studio sessions stay out of Focus's attention tally as well as its rows, so the tab title and phone dot never count a session no list shows.
- The browser names a repo only by a box on its area, and a new repo only through `add-session` with `studio`, never by a bare path, because the server must resolve every path it acts on (trust boundary). That same request is the one way a repo's branch agent is set, so the agent mark on a repo card reopens the dialog on that repo instead of sending its own message.
- Studio's repos are the stored Studio repo list, one map area each; `add-session` with `studio` adds the repo and wakes or creates the one Orchestrator (decided in `server/core/studio-main-core.ts`). It runs in a Studio home outside every repo, so a sandboxed Orchestrator reads every repo and can write none.
- Studio agent behavior lives in `mcp/core/studio-playbook.ts`, one entry per behavior and role, so changing how Studio agents work is editing an entry there, never adding prose to other instructions.
- `server/board-session/studio-migration.ts` moves every per-repo main under the one Orchestrator and runs `migrateStudioToAcp` at start. Both stay synchronous and ahead of `sessionRegistry.initialize()`, because a session's parent link and driver are fixed when the session is built; `migrateStudioToAcp` migrates pre-ACP Studio sessions onto ACP in one write (preserving `resumeSessionId` with a one-shot fresh-session fallback if `session/load` fails) and leaves any Studio project whose agent has no ACP row stopped with one trace notice and its `agent` unchanged rather than switching agents or falling back to PTY (pinned by the Studio migration test).
- Every Studio session (Orchestrator and branches) runs on the ACP driver only through `decideSessionDriver` in `session/core/session-driver-core.ts`, never PTY, while Focus keeps PTY: Studio needs structured events without terminal scraping. The Studio picker queries `list-agents` with `driver: 'acp'` to offer only built-in and `config.acpAgents` rows, and spawning a non-ACP agent in Studio is refused (pinned by the Studio ACP driver test).
- No Studio code path (`public/board-session/`, `server/board-session/`, `mcp/core/studio-playbook.ts`) names, shows, or waits on a terminal: a failed agent shows on its card and keeps the Orchestrator dock log open, and an expired login is signed in outside Glimmervoid (pinned by the Studio no-terminal gate and the board-session browser harness).
- Whether a branch's work has landed is `isBranchWorkLanded` in `server/board-session/landed-branches.ts`: nothing uncommitted and no commit ahead of its repo's integration branch. Self-close and the close refusal both read it, and nothing is stored, so neither can go stale. A branch closes itself only after it was seen settled with unlanded work, so one that asked or planned first keeps its session.
- The log keeps prompts and replies only; tool, skill, subagent and workflow activity shows on branch cards, box glows and the Orchestrator's one activity line closing the log, never as log rows.
- The log keeps its compact height: answers belong on the board (the board-first playbook entry) and the director trims what reaches chat, because a log that grows covers the map the operator works on.
- Codemap elements are generated, so folder stacking changes only through `codemap-folder-set`, never by setting a frame's `collapsed`.
- Studio draws its map through the shared Boards host (`mountBoardHost`, `showBoardBeside` with a `BoardHostGuest`), never a canvas of its own, so every board behavior reaches Studio and Boards alike; new board behavior goes in `public/whiteboard/`.
- The open log's background stays slightly translucent: Chrome treats an opaque scroller's scrolled-off rows as covering the board canvas, which then stops drawing above the log.
- Any new view under `public/board-session/` is a Solid 2 `.tsx` island following the Solid 2 Components conventions in `public/AGENTS.md` (one function per `.tsx` file, pure `*-core.ts` beside it, mounted through `public/ui/island.ts`, reading stores via `public/ui/store-signal.ts`), so new Studio surfaces do not add imperative DOM to convert later (pinned by the solid-views and solid-2-only gates).
