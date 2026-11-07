# Mcp

The agent MCP endpoint: one shared stateless route through which every supervised agent with an MCP client reaches its Glimmervoid verbs

## entrances
- mcp route: a session's agent CLI calls a Glimmervoid tool over streamable HTTP, presenting its session id and token as one bearer
  handler: server.ts
  trust: agent-session

## invariants
- mcp route session token: A tool call runs only for a session presenting its own id and token as the bearer, and a missing, wrong, misshapen or foreign credential is refused like an unknown session.
  over: the MCP calls the route receives with no bearer, a wrong secret, an unknown id, a bare secret and an empty secret
  via: a missing, wrong or misshapen credential gets the unknown-session refusal
  because: a tool call can spawn sessions and push to main; a forged call must not act as any session, and a distinct refusal would let the endpoint be probed for live ids
  crossing: agent-session -> host
  entrances: mcp route
  kinds: credential, identity
  checklist: capability-authorization declared as mcp route session token
  checklist: revalidated-permission dismissed: each tool call is authorized when its request arrives, nothing is queued under an older credential
  checklist: message-authenticity dismissed: the credential is a bearer secret; no signed message is accepted
  checklist: encrypted-storage dismissed: the session token lives in memory and in the agent environment only, never persisted by this route
  checklist: key-rotation-compatibility dismissed: no key is held or rotated; each session gets its own minted token
  checklist: canonical-encoding dismissed: only the Bearer scheme and surrounding whitespace are normalized; the id and secret after them are compared byte for byte, and minted tokens hold no whitespace
  checklist: identity-continuity dismissed: a session keeps one id for its life; there is no anonymous-to-identified change
  checklist: separation-of-duties dismissed: one actor, the session presenting its own token, makes and authorizes each call
