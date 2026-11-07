# Glimmervoid

A local agent orchestrator: a Node.js process that spawns and supervises coding agent sessions in PTYs, streams them to a browser dashboard and notifies the operator.

## trust levels
- operator: the dashboard and control WebSocket on loopback carrying the page token, and the glimmervoid CLI the operator runs
- agent-session (outside): what an agent process sends back, its hook POSTs, agent API calls and PTY output
- remote (outside): responses and messages from Telegram, GitHub, PostHog and other network services
- repository: the contents of a session worktree, trusted as the operator's own code
- host: the glimmervoid process, its config store, its session records and journal

## entrances
- glimmervoid: the operator runs the glimmervoid CLI to start, stop or query the server; inside a session the same CLI reaches the server only through the agent route
  handler: bin/glimmervoid.ts
  trust: operator
- build: the operator or npm builds the dashboard and node bundles into dist
  handler: scripts/build.mjs
  trust: operator
- generate animal sprites: the operator regenerates the dashboard animal sprites
  handler: scripts/generate-animal-sprites.ts
  trust: operator
- generate config docs: the operator regenerates the configuration reference from the settings registry
  handler: scripts/generate-config-docs.ts
  trust: operator
- postinstall path check: npm checks after install that the glimmervoid bin is on PATH
  handler: scripts/postinstall-path-check.ts
  trust: operator
- postinstall: npm runs the package's post-install steps for the operator's install
  handler: scripts/postinstall.mjs
  trust: operator
- harness: the operator runs the browser harness, which serves the dashboard from the Vite dev server, drives it in a real browser and reports what broke
  handler: harness/browser/harness.ts
  trust: operator
- capture: the operator captures the public site's screenshots of the dashboard
  handler: harness/site-capture/capture.ts
  trust: operator
- record: the operator records the public site's dashboard video
  handler: harness/site-capture/record.ts
  trust: operator
- prepare build: npm builds dist before packing or after a source install
  handler: scripts/prepare-build.js
  trust: operator
- release: the operator cuts a versioned release from the changelog
  handler: scripts/release.ts
  trust: operator
