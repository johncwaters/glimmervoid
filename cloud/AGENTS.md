# cloud

The Glimmervoid Cloud split: an always-on watcher process and the job inbox it delivers to inside the tenant's Glimmervoid server.

## Key Files

| File | Role |
|------|------|
| `inbox/core/job-inbox-core.ts` | Bind decision, bearer check, job parse, recent-jobId dedupe |
| `inbox/job-inbox-listener.ts` | The inbox request handler: POST /jobs |
| `inbox/job-inbox-wiring.ts` | Turns `config.watcher` into a bind decision and a token |
| `shared/contracts/watcher-jobs.ts` | The job envelope and the per-kind payload registry every lane registers into |

## Invariants

### Watcher Job Inbox

- The inbox answers only a bearer token, never the dashboard's device cookie or Tailscale header: it is a machine-to-machine door, and sharing the remote listener's auth would let a paired phone forge jobs.
- A non-loopback inbox needs `GLIMMERVOID_WATCHER_TOKEN`; the random per-boot token only ever guards a loopback bind, because nothing outside the machine can learn it.
- A lane adds a job kind only by registering a Zod payload schema in `WATCHER_JOB_KINDS`, so the inbox refuses anything a lane has not declared.
- One writer per state file: the watcher owns external-world state, the server owns sessions and config, and the two never share a Glimmervoid home.
