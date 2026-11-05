# Backend

The HTTP server and its routes, both WebSockets, health and lane wiring: the one place outside work enters the backend

## entrances
- hook route: an agent's Claude Code or Codex hook posts a lifecycle event for its session, carrying the per-session bearer token
  handler: backend-http.ts
  trust: agent-session
- agent route: a session runs a glimmervoid agent verb (push, spawn, attention, board, limits) and the CLI posts it with the session token
  handler: backend-http.ts
  trust: agent-session
- sign route: a session asks the server to sign a payload for it, presenting the session token
  handler: backend-http.ts
  trust: agent-session
- control token route: the dashboard page fetches the control WebSocket token from loopback
  handler: backend-http.ts
  trust: operator
- open external route: the dashboard inside an editor's browser view asks the host to open a link outside it
  handler: backend-http.ts
  trust: operator
- upload route: the operator attaches a file to a session from the dashboard
  handler: backend-http.ts
  trust: operator
- upload read route: the dashboard reads back a file attached to a session
  handler: backend-http.ts
  trust: operator
- control socket: the dashboard opens the control WebSocket and sends JSON control messages
  handler: createBackendWebSockets in backend-websockets.ts
  trust: operator
- terminal socket: the dashboard opens a session's data WebSocket and types into its PTY
  handler: createBackendWebSockets in backend-websockets.ts
  trust: operator

## invariants
- hook route session token: A hook call changes a session only when it presents that session's own bearer token, and a missing, wrong or unknown-session token changes nothing.
  over: the hook calls the router handles for a registered session presenting a wrong token
  via: HookRouter rejects bad token (403)
  because: any local process can reach the loopback port; without the per-session token it could forge another session's lifecycle events
  crossing: agent-session -> host
  entrances: hook route
  kinds: credential, identity
  checklist: capability-authorization declared as hook route session token
  checklist: revalidated-permission dismissed: a hook call is handled at once, nothing is queued
  checklist: message-authenticity dismissed: the bearer token authenticates the caller; the body carries no signature by design
  checklist: encrypted-storage dismissed: the token lives in memory and in the session's own environment, never persisted
  checklist: key-rotation-compatibility dismissed: each session gets a fresh token, nothing rotates in place
  checklist: canonical-encoding dismissed: the token is compared as an opaque string
  checklist: identity-continuity dismissed: a session keeps its UUID and token for its whole life
  checklist: separation-of-duties dismissed: one role, the session's own agent, calls the route
- agent route session token: An agent verb or a commit signing request runs only for a session presenting its own token for that route, and a missing, wrong or hook token is refused like an unknown session.
  over: the agent calls the route receives with no token, a wrong token, the hook token and an unknown session id
  via: a missing, wrong or hook token is refused with the unknown-session answer
  because: an agent verb can spawn sessions and push to main, and a signature vouches for a commit as the operator's; a forged call must not act as any session
  crossing: agent-session -> host
  entrances: agent route, sign route
  kinds: credential, identity
  checklist: capability-authorization declared as agent route session token
  checklist: revalidated-permission dismissed: a verb is decided when it arrives, nothing is queued under an older grant
  checklist: message-authenticity dismissed: the bearer token authenticates the caller; the body carries no signature by design
  checklist: encrypted-storage dismissed: the token is never persisted
  checklist: key-rotation-compatibility dismissed: each session gets a fresh token, nothing rotates in place
  checklist: canonical-encoding dismissed: the token is compared as an opaque string
  checklist: identity-continuity dismissed: a session keeps its UUID and token for its whole life
  checklist: separation-of-duties dismissed: one role, the session's own agent, calls the route
- loopback only: With remote mode off the backend binds loopback alone and mounts no pairing route.
  over: the backend started with remote disabled
  via: the backend reports remote disabled and a loopback bind host
  because: binding 0.0.0.0 would expose every session's terminal and control socket to the network
  crossing: remote -> host
  entrances: none
  kinds: identity
  checklist: capability-authorization dismissed: binding decides reachability, not what a credential authorizes
  checklist: canonical-encoding dismissed: the bind host is a fixed loopback address, not a normalized input
  checklist: identity-continuity dismissed: no identity is carried across the bind
