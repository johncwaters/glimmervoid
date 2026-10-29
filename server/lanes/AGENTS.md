# server/lanes

Lane spawning: the ephemeral judge lanes and the interactive work lane, with their logging and status.

## Key Files

| File | Rule |
|------|------|
| `lane-spawn.ts` | Ephemeral lane spawn on the lane-permissions seam; every lane is wrapped in the judge guardrails role (`server/guardrails/core/guardrails-roles-core.ts`), bar Windows |
| `work-lane.ts` | Shared work guardrails helpers for interactive lanes |
| `lane-mcp.ts` | Read-only PostHog MCP posture shared by both lane spawn chokepoints |

## Invariants

Each entry is a rule, its why, and where it is pinned. Mechanism lives in the code.

### Ephemeral Lane Write Boundaries

- THE boundary is `defaultMode: acceptEdits` plus a throwaway cwd holding only the result file. Four plausible spellings fail SILENTLY, so every clause below comes from live probes recorded in `server/lanes/core/lane-permissions-core.ts`.
- Team PR review copies into the local store under the Glimmervoid home instead, never a git repository: those repos may be the team's.
- No lane may grant a bare `Write` allow, which unbounds the writes, and nothing narrower grants the tool.
- A PATH DENY is not a write boundary: probed with a bare `Write` allow present, both spellings let the write through, and a rule that looks like a boundary and is not is worse than none.
- No lane may deny bare `Read`, `Write`, `Glob` or `Grep`: a bare `Read` deny refuses the Write tool, mutually exclusive with a result-file contract.
- The mode is set in the lane's managed settings file, overriding the operator's own, or `defaultMode: auto` leaves a classifier deciding these writes instead of a rule.
- A lane prompt is written in its throwaway cwd and invoked by a constant bootstrap argument, since a Windows `.cmd` shim re-parses argv through `cmd.exe` (`server/core/workflows-core.ts`).

### Lane PostHog MCP

- A lane reaches PostHog only through the operator's own `mcp.posthog.com` server entry copied unchanged, since any URL or header change loses its stored OAuth login, and only behind the `posthogReadGate` hook tool.
- Claude Code, Codex and Kimi Code all run a tool when a PreToolUse hook crashes, so the gate exits 2 on any error and `lane-mcp.ts` drops PostHog when its self-test does not deny a known write.
- The `mcp__<name>__exec` allow rule rides in the same settings file as the gate hook, so a failed hook injection drops the permission with it; PostHog needs a hook router for that reason.
- Codex skips hooks passed with `-c` unless launched with `--dangerously-bypass-hook-trust`, and it fired PreToolUse on MCP calls only from 0.165.0 on, so its PostHog approval arg comes out of hook injection only beside the trusted gate on such a Codex; anywhere else a call still needs approval.
- Kimi Code runs MCP calls in `-p` with no approval, so a Kimi Code lane reaches PostHog only through the guardrails launch home's `launchHomeFiles`, which point its `mcp.json` and `config.toml` at lane files holding only the PostHog entry and the gate hook, and only for a server name Kimi Code keeps unchanged in its tool names (no `__`, 64 characters), or its hook matcher never fires; unsandboxed, it gets no PostHog network route.
- Known gap, accepted by the operator 2026-10-29: the sandbox allowlist opens `mcp.posthog.com` to the whole lane, so a lane that keeps a general shell can reach PostHog around the gate. Claude and its Bash children share one srt policy, and macOS refuses a nested sandbox, so closing it needs a sandbox split or a loopback relay, not a gate change.
