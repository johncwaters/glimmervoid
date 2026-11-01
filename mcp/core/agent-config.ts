import type { BUILTIN_AGENT_IDS } from '../../shared/contracts/config.ts';
import { mcpCredentialFor } from './credentials.ts';

const MCP_CREDENTIAL_ENV = 'GLIMMERVOID_MCP_TOKEN';
const MCP_SERVER_NAME = 'glimmervoid';

interface McpLaunchInput {
  agentId: string;
  listenerPort: number | null;
  sessionId: string;
  agentToken: string | null;
}

interface McpLaunch {
  args: string[];
  env: Record<string, string>;
}

const NO_MCP_LAUNCH: McpLaunch = Object.freeze({ args: [], env: {} });

function mcpUrl(listenerPort: number): string {
  return `http://127.0.0.1:${listenerPort}/mcp`;
}

function claudeMcpArgs(url: string): string[] {
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer \${${MCP_CREDENTIAL_ENV}}` } },
    },
  };
  return ['--mcp-config', JSON.stringify(config), '--allowedTools', `mcp__${MCP_SERVER_NAME}`];
}

type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number];

const ARGS_BY_AGENT: Readonly<Partial<Record<BuiltinAgentId, (url: string) => string[]>>> = Object.freeze({
  'claude-code': claudeMcpArgs,
});

function isBuiltinWithMcpArgs(agentId: string): agentId is keyof typeof ARGS_BY_AGENT {
  return Object.hasOwn(ARGS_BY_AGENT, agentId);
}

function mcpLaunchFor({ agentId, listenerPort, sessionId, agentToken }: McpLaunchInput): McpLaunch {
  const buildArgs = isBuiltinWithMcpArgs(agentId) ? ARGS_BY_AGENT[agentId] : undefined;
  if (!buildArgs || !listenerPort || !agentToken) return NO_MCP_LAUNCH;
  return {
    args: buildArgs(mcpUrl(listenerPort)),
    env: { [MCP_CREDENTIAL_ENV]: mcpCredentialFor(sessionId, agentToken) },
  };
}

export { MCP_CREDENTIAL_ENV, mcpLaunchFor };
export type { McpLaunch, McpLaunchInput };
