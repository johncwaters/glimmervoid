# mcp

Every line of MCP code lives here; files outside `mcp/` only import from it, so the protocol surface can change or be replaced without touching the session domain.

- A tool call lands in `AgentApiPort.handle`, the same port the `/agent` route uses, so a verb's rules, role limits and replies stay one implementation.
- The bearer is `<sessionId>.<agentToken>` from `GLIMMERVOID_MCP_TOKEN`, never argv: `/proc/<pid>/cmdline` is world-readable. The id prefix makes the lookup O(1) and the shared Kimi Code home cannot carry a per-session URL.
- A refusal answers exactly like the `/agent` route (`REFUSAL_STATUS`, `REFUSAL_REASON`), so the endpoint cannot be probed for live session ids.
- One shared stateless endpoint, a fresh server per request: never a process or a stored transport per session.
- Kimi Code 2.4.1 never applies `[[permission.rules]]` from config and its hooks can only deny, so a Kimi Code session approves Glimmervoid tools only under `--yolo`; an allow rule there is dead config.
