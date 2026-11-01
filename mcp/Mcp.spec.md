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
