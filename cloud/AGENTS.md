# cloud

The watcher, a process that runs the probes the server compiles and nudges the server when one changes, and the server's half of that link.

## Key Files

| File | Role |
|------|------|
| `link/core/link-signing-core.ts` | Per-direction keys from the link secret, request signing and verification |
| `link/watcher-link.ts` | Server half: compiles the probe set, delivers it and the credentials, takes nudges, switches each probe source between timers and nudges |
| `link/link-secret.ts` | The link secret kept 0600 in the Glimmervoid home, so the watcher's sealed credentials survive a server restart |
| `link/remote-watcher-starter.ts` | Finds the watcher through its doorman by status check, starting the local doorman first when `remote.doormanUrl` is unset |
| `doorman/github-app.ts` | The doorman's GitHub App: key from Secret Manager, installation token mints |
| `doorman/doorman-state.ts`, `doorman/gcp-rest.ts` | Where a doorman's table, link secrets, awake ledgers and watcher files live: a table file, or a state bucket and Secret Manager (`--state`); the Google REST calls all doorman code shares |
| `doorman/doorman.ts`, `doorman/ensure-doorman.ts` | `glimmervoid doorman`, which hosts each tenant's watcher, and the server's connect-or-spawn of its own local doorman |
| `watcher/watcher-listener.ts` | The watcher's signed listener, served under `/link/watcher/` |
| `watcher/probe-runner.ts`, `watcher/core/probe-core.ts` | Runs each probe on its interval and decides when a result is a nudge |
| `watcher/watcher-home.ts` | The probe set and the encrypted credentials the watcher keeps across restarts |
| `shared/contracts/watcher-link.ts` | Probe, probe set, nudge and credential shapes |

## Invariants

### Watcher Link

- The watcher holds no lane logic and never parses a response: a probe's answer is only hashed, so a new lane never needs a watcher change and a compromised watcher learns nothing it could act on.
- `cloud/watcher/` imports only the link contract, the signing core and its own code, so it runs on a box with no server.
- Each direction signs with its own key derived from the link secret, so a captured nudge can never be replayed as a probe set.
- A GitHub credential only reaches `api.github.com` and a PostHog key only its own host, whatever URL a probe names. `GLIMMERVOID_GITHUB_API_BASE` may move GitHub probes, but only to a loopback address (the end-to-end runs' fake GitHub), so a token never leaves the machine in plain http (`githubApiOrigin`).
- A lane skips a timed read only while the watcher runs that exact request healthily and the lane already holds its first answer, because the watcher never nudges on a probe's first answer; anything else stays on the lane's timers, so the watcher only ever makes polling cheaper.
- The doorman is the only way a watcher runs, self-host included: the server never spawns a watcher, so one nudge path is tested for every install. Its nudges enter the remote listener ahead of remote-auth, guarded by the link signature alone.
- A local doorman outlives server restarts and is found by its lock and port file, never by pid, and stops when its tenant table is deleted, so a removed Glimmervoid home leaves no daemon behind. Its port file is trusted only while its lock is held, because the server sends credentials there; without kernel locks there is no local doorman.
- Only the doorman holds the GitHub App key, read at runtime from Secret Manager alias `current`, never a file or env var, because Google's guidance is runtime access to a pinned version and the alias lets rotation move it. Every minted token asks for read permissions only, so a write grant added to the App never reaches a tenant.
