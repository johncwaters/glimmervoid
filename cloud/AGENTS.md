# cloud

The Glimmervoid Cloud split: an always-on watcher process and the job inbox it delivers to inside the tenant's Glimmervoid server.

## Key Files

| File | Role |
|------|------|
| `inbox/core/job-inbox-core.ts` | Bind decision, bearer check, job parse, recent-jobId dedupe |
| `inbox/job-inbox-listener.ts` | The inbox request handler: POST /jobs, GET /watchees |
| `inbox/job-inbox-wiring.ts` | Turns `config.watcher` into a bind decision and a token; starts the local watcher once the inbox is bound |
| `watcher/core/watcher-core.ts` | Inbox URL rule, reply classification, delivery retry delay |
| `watcher/job-inbox-client.ts` | Delivers one job, retrying with the same jobId |
| `watcher/watcher-supervisor.ts` | Runs `glimmervoid watch` as an IPC child of the server, restarting it with backoff |
| `watcher/watch-cli.ts` | `glimmervoid watch`: no sessions, PTYs or dashboard |
| `inbox/watchee-handlers.ts`, `inbox/watchee-settings-sync.ts` | Server half of a watchee: the handler per job kind; the lane settings the inbox publishes on boot and on every settings save |
| `watchees/watchee.ts`, `watchees/registry.ts` | The watchee shape and the registry keyed by job kind |
| `watchees/<lane>/`, `watchees/github-store-watchee.ts` | One lane's watching code; the GitHub store and event key every GitHub watchee shares |
| `watcher/watchee-runner.ts`, `watcher/core/watchee-runner-core.ts` | Runs each gated watchee on its trigger, derives jobIds, keeps `sent-events.json` |
| `watcher/watchee-settings.ts` | The watcher home and the watcher's own cached copy of its fetched settings |
| `shared/contracts/watcher-jobs.ts`, `shared/contracts/watchee-settings.ts` | The job envelope, the per-kind payload registry every lane registers into, and the watchee settings file |

## Invariants

### Watcher Job Inbox

- The inbox answers only a bearer token, never the dashboard's device cookie or Tailscale header: it is a machine-to-machine door, and sharing the remote listener's auth would let a paired phone forge jobs.
- A non-loopback inbox needs `GLIMMERVOID_WATCHER_TOKEN`; the random per-boot token only ever guards a loopback bind, because nothing outside the machine can learn it.
- The watcher sends its token over plain http only to a loopback inbox; any other host needs https, since the bearer token is the inbox's only guard.
- A job is remembered as seen only after its handler succeeds, and a retry of a job still running gets 409, so a retried job is never acked before it ran.
- A lane adds a job kind only by registering a Zod payload schema in `WATCHER_JOB_KINDS`, so the inbox refuses anything a lane has not declared.
- The auto-started watcher is an IPC child that exits on disconnect, so no server exit path, including SIGKILL, leaves it orphaned.
- One writer per state file: the watcher owns external-world state, the server owns sessions and config, and the two never share a Glimmervoid home.

### Watchees

- A lane on the watcher is a pair keyed by job kind: a `Watchee` in `watchees/registry.ts` and a handler in `withBuiltInJobHandlers`; both are mapped types over `WATCHER_JOB_KINDS`, so a kind missing either half fails typecheck.
- A watchee only detects and delivers; planning, drafts and spawning stay on the server. A boundary gate pins its imports.
- A watchee's API key reaches the watcher only in its child env, never `watchees.json`, so the settings file never holds a secret.
- The watcher pulls its settings from GET /watchees and refetches at start, on the local supervisor's nudge, when an ack's `settingsRevision` differs, and on a timer only while it holds no settings or runs no lane, so a watcher on another machine needs no inbound port and never wakes a sleeping server just to check while it has work.
- A level watchee re-sends its whole level every interval (jobId from interval start plus a payload hash): a restarted server recovers without a resync protocol, and the server drops a payload older than the last one it accepted.
- A stream watchee moves its cursor only in `acknowledged`, after the inbox's 2xx, and the server acks only after it saved what it parsed, so a row is never lost between the two; a watchee keeps that cursor through `context.files`, never its own file IO.
