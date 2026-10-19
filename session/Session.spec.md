# Session

The session domain: spawning, supervising, resuming and shutting down agent sessions in PTYs, and the per-agent adapters

## entrances
- pty output: an agent process writes to its terminal, and the bytes reach the screen keeper, the recorder and the dashboard
  handler: Session in sessions.ts
  trust: agent-session

## invariants
