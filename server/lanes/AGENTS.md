# server/lanes

Lane spawning: the ephemeral judge lanes and the interactive work lane, with their logging and status.

## Key Files

| File | Rule |
|------|------|
| `lane-spawn.ts` | Ephemeral lane spawn on the lane-permissions seam; every lane is wrapped in the judge guardrails role (`server/guardrails/core/guardrails-roles-core.ts`), bar Windows |
| `work-lane.ts` | Shared work guardrails helpers for interactive lanes |

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Ephemeral Lane Write Boundaries

- THE boundary is `defaultMode: acceptEdits` plus a throwaway cwd holding only the result file. Four plausible spellings fail SILENTLY, so every clause below comes from live probes recorded in `server/lanes/core/lane-permissions-core.ts`.
- Team PR review copies into the local store under the Glimmervoid home instead, never a git repository: those repos may be the team's.
- No lane may grant a bare `Write` allow, which unbounds the writes, and nothing narrower grants the tool.
- A PATH DENY is not a write boundary: probed with a bare `Write` allow present, both spellings let the write through, and a rule that looks like a boundary and is not is worse than none.
- No lane may deny bare `Read`, `Write`, `Glob` or `Grep`: a bare `Read` deny refuses the Write tool, mutually exclusive with a result-file contract.
- The mode is set in the lane's managed settings file, overriding the operator's own, or `defaultMode: auto` leaves a classifier deciding these writes instead of a rule.
- A lane prompt is written in its throwaway cwd and invoked by a constant bootstrap argument, since a Windows `.cmd` shim re-parses argv through `cmd.exe` (`server/visions/visions-dispatch.ts`, `server/change-map/change-narrator.ts`).
