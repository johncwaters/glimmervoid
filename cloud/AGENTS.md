# cloud

The watcher, a process that runs the probes the server compiles and nudges the server when one changes, and the server's half of that link.

## Key Files

| File | Role |
|------|------|
| `link/core/link-signing-core.ts` | Per-direction keys from the link secret, request signing and verification |
| `link/watcher-link.ts` | Server half: compiles the probe set, delivers it and the credentials, takes nudges, switches each probe source between timers and nudges |
| `link/link-secret.ts` | The link secret kept 0600 in the Glimmervoid home, so the watcher's sealed credentials survive a server restart |
| `link/watcher-supervisor.ts` | Runs `glimmervoid watch` as an IPC child of the server, restarting it with backoff |
| `watcher/watch-cli.ts`, `watcher/watcher-listener.ts` | `glimmervoid watch` and its signed loopback listener |
| `watcher/probe-runner.ts`, `watcher/core/probe-core.ts` | Runs each probe on its interval and decides when a result is a nudge |
| `watcher/watcher-home.ts` | The probe set and the encrypted credentials the watcher keeps across restarts |
| `shared/contracts/watcher-link.ts` | Probe, probe set, nudge and credential shapes |

## Invariants

### Watcher Link

- The watcher holds no lane logic and never parses a response: a probe's answer is only hashed, so a new lane never needs a watcher change and a compromised watcher learns nothing it could act on.
- `cloud/watcher/` imports only the link contract, the signing core and its own code, so it runs on a box with no server.
- Each direction signs with its own key derived from the link secret, so a captured nudge can never be replayed as a probe set.
- A GitHub credential only reaches `api.github.com` and a PostHog key only its own host, whatever URL a probe names.
- A lane skips a timed read only while the watcher runs that exact request healthily and the lane already holds its first answer, because the watcher never nudges on a probe's first answer; anything else stays on the lane's timers, so the watcher only ever makes polling cheaper.
