# cloud

The Glimmervoid Cloud split: an always-on watcher process and the job inbox it delivers to inside the tenant's Glimmervoid server.

## Key Files

| File | Role |
|------|------|
| `inbox/core/job-inbox-core.ts` | Bind decision, bearer check, job parse, recent-jobId dedupe |
| `inbox/job-inbox-listener.ts` | The inbox request handler: POST /jobs |
| `inbox/job-inbox-wiring.ts` | Turns `config.watcher` into a bind decision and a token; starts the local watcher once the inbox is bound |
| `watcher/core/watcher-core.ts` | Inbox URL rule, reply classification, delivery retry delay |
| `watcher/job-inbox-client.ts` | Delivers one job, retrying with the same jobId |
| `watcher/watcher-supervisor.ts` | Runs `glimmervoid watch` as an IPC child of the server, restarting it with backoff |
| `watcher/watch-cli.ts` | `glimmervoid watch`: no sessions, PTYs or dashboard |
| `shared/contracts/watcher-jobs.ts` | The job envelope and the per-kind payload registry every lane registers into |

## Invariants

### Watcher Job Inbox

- The inbox answers only a bearer token, never the dashboard's device cookie or Tailscale header: it is a machine-to-machine door, and sharing the remote listener's auth would let a paired phone forge jobs.
- A non-loopback inbox needs `GLIMMERVOID_WATCHER_TOKEN`; the random per-boot token only ever guards a loopback bind, because nothing outside the machine can learn it.
- The watcher sends its token over plain http only to a loopback inbox; any other host needs https, since the bearer token is the inbox's only guard.
- A job is remembered as seen only after its handler succeeds, and a retry of a job still running gets 409, so a retried job is never acked before it ran.
- A lane adds a job kind only by registering a Zod payload schema in `WATCHER_JOB_KINDS`, so the inbox refuses anything a lane has not declared.
- The auto-started watcher is an IPC child that exits on disconnect, so no server exit path, including SIGKILL, leaves it orphaned.
- One writer per state file: the watcher owns external-world state, the server owns sessions and config, and the two never share a Glimmervoid home.
