import type { BUILTIN_AGENT_IDS } from '../../shared/contracts/config.ts';
import { mcpCredentialFor } from './credentials.ts';

const MCP_CREDENTIAL_ENV = 'GLIMMERVOID_MCP_TOKEN';
const MCP_SERVER_NAME = 'glimmervoid';
const MCP_TOOL_TIMEOUT_SECONDS = 600;
const CODEX_TOOL_INPUT_SCHEMA_MAX_BYTES = 16384;
const KIMI_MCP_CONFIG_NAME = 'mcp.json';
const KIMI_MCP_BASE_NAME = '.glimmervoid-mcp-base.json';

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

function codexMcpArgs(url: string): string[] {
  const settings = [
    `url=${JSON.stringify(url)}`,
    `bearer_token_env_var=${JSON.stringify(MCP_CREDENTIAL_ENV)}`,
    'default_tools_approval_mode="approve"',
    `tool_timeout_sec=${MCP_TOOL_TIMEOUT_SECONDS}`,
    `tool_input_schema_max_bytes=${CODEX_TOOL_INPUT_SCHEMA_MAX_BYTES}`,
  ];
  return settings.flatMap((setting) => ['-c', `mcp_servers.${MCP_SERVER_NAME}.${setting}`]);
}

function credentialOnly(): string[] {
  return [];
}

type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number];

const ARGS_BY_AGENT: Readonly<Partial<Record<BuiltinAgentId, (url: string) => string[]>>> = Object.freeze({
  'claude-code': claudeMcpArgs,
  codex: codexMcpArgs,
  kimi: credentialOnly,
});

type McpServers = Record<string, unknown>;

function mcpServersOf(mcpJsonText: string | null): McpServers | null {
  if (mcpJsonText === null) return null;
  try {
    const parsed: unknown = JSON.parse(mcpJsonText);
    if (typeof parsed !== 'object' || parsed === null || !('mcpServers' in parsed)) return {};
    const servers = parsed.mcpServers;
    return typeof servers === 'object' && servers !== null && !Array.isArray(servers) ? { ...servers } : {};
  } catch {
    return null;
  }
}

function withoutGlimmervoidServer(servers: McpServers): McpServers {
  return Object.fromEntries(Object.entries(servers).filter(([name]) => name !== MCP_SERVER_NAME));
}

function isSameServer(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function mergedServer(name: string, base: McpServers, ours: McpServers, theirs: McpServers): unknown {
  if (isSameServer(theirs[name], base[name])) return ours[name];
  return theirs[name];
}

function mergeOperatorServers(base: McpServers | null, ours: McpServers | null, theirs: McpServers): McpServers {
  if (ours === null) return theirs;
  const baseServers = base ?? {};
  const names = new Set([...Object.keys(baseServers), ...Object.keys(ours), ...Object.keys(theirs)]);
  const merged: McpServers = {};
  for (const name of names) {
    const server = mergedServer(name, baseServers, ours, theirs);
    if (server !== undefined) merged[name] = server;
  }
  return merged;
}

interface KimiMcpSources {
  realMcpJson: string | null;
  generatedMcpJson: string | null;
  baseMcpJson: string | null;
  listenerPort: number;
}

function serversFileText(servers: McpServers): string {
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

function kimiMcpFiles({ realMcpJson, generatedMcpJson, baseMcpJson, listenerPort }: KimiMcpSources): Record<string, string> {
  const realServers = mcpServersOf(realMcpJson);
  const generatedServers = mcpServersOf(generatedMcpJson);
  const ours = generatedServers === null ? null : withoutGlimmervoidServer(generatedServers);
  const isRealFileUnreadable = realMcpJson !== null && realServers === null;
  const theirs = withoutGlimmervoidServer(realServers ?? {});
  const operatorServers = isRealFileUnreadable ? ours ?? {} : mergeOperatorServers(mcpServersOf(baseMcpJson), ours, theirs);
  const glimmervoidServer = {
    transport: 'http',
    url: mcpUrl(listenerPort),
    bearerTokenEnvVar: MCP_CREDENTIAL_ENV,
    toolTimeoutMs: MCP_TOOL_TIMEOUT_SECONDS * 1000,
  };
  return {
    [KIMI_MCP_CONFIG_NAME]: serversFileText({ ...operatorServers, [MCP_SERVER_NAME]: glimmervoidServer }),
    [KIMI_MCP_BASE_NAME]: isRealFileUnreadable ? baseMcpJson ?? serversFileText(operatorServers) : serversFileText(theirs),
  };
}

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

export { KIMI_MCP_BASE_NAME, KIMI_MCP_CONFIG_NAME, MCP_CREDENTIAL_ENV, kimiMcpFiles, mcpLaunchFor };
export type { McpLaunch, McpLaunchInput };
