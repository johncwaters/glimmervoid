# Server

The backend runtime: the HTTP server and both WebSockets on loopback, the lanes, git workspace management and the shell around every pure core

## entrances
- hook route: an agent's Claude Code or Codex hook posts a lifecycle event for its session, carrying the per-session bearer token
  handler: backend/backend-http.ts
  trust: agent-session
- agent route: a session runs a glimmervoid agent verb (push, spawn, attention, board, limits) and the CLI posts it with the session token
  handler: backend/backend-http.ts
  trust: agent-session
- sign route: a session asks the server to sign a payload for it, presenting the session token
  handler: backend/backend-http.ts
  trust: agent-session
- control token route: the dashboard page fetches the control WebSocket token from loopback
  handler: backend/backend-http.ts
  trust: operator
- open external route: the dashboard inside an editor's browser view asks the host to open a link outside it
  handler: backend/backend-http.ts
  trust: operator
- upload route: the operator attaches a file to a session from the dashboard
  handler: backend/backend-http.ts
  trust: operator
- upload read route: the dashboard reads back a file attached to a session
  handler: backend/backend-http.ts
  trust: operator
- pair route: a device on the network redeems a pairing token to join remote mode
  handler: remote-auth.ts
  trust: remote
- control socket: the dashboard opens the control WebSocket and sends JSON control messages
  handler: createBackendWebSockets in backend/backend-websockets.ts
  trust: operator
- terminal socket: the dashboard opens a session's data WebSocket and types into its PTY
  handler: createBackendWebSockets in backend/backend-websockets.ts
  trust: operator
- visions socket: the editor extension streams open documents to the Visions lane over LSP
  handler: createVisionsWiring in visions/visions-wiring.ts
  trust: operator

## invariants
