import { createHash } from 'node:crypto';
import type { BUILTIN_AGENT_IDS } from '../../shared/contracts/config.ts';
import { GLIMMERVOID_MCP_SERVER_NAME } from '../../shared/contracts/pack.ts';
import type { PackMcpServer } from '../../shared/contracts/pack.ts';
import {
  KIMI_MCP_BASE_NAME,
  KIMI_MCP_CONFIG_NAME,
  KIMI_PACK_SERVERS_NAME,
  MCP_CREDENTIAL_ENV,
  PACK_SECRET_ENV_PREFIX,
  packSecretEnvName,
} from '../../server/core/mcp-env-core.ts';
import { mcpCredentialFor } from './credentials.ts';

const MCP_URL_ENV = 'GLIMMERVOID_MCP_URL';
const MCP_SERVER_NAME = GLIMMERVOID_MCP_SERVER_NAME;
const MCP_TOOL_TIMEOUT_SECONDS = 600;
const CLAUDE_MCP_TOOL_TIMEOUT_ENV = 'MCP_TOOL_TIMEOUT';
const CODEX_TOOL_INPUT_SCHEMA_MAX_BYTES = 16384;
const KIMI_PACK_SERVER_NAMES_KEY = 'names';
const KIMI_SHADOWED_SERVERS_KEY = 'shadowedServers';

interface McpLaunchInput {
  agentId: string;
  listenerPort: number | null;
  sessionId: string;
  agentToken: string | null;
  packServers: readonly PackMcpServer[];
}

interface McpLaunch {
  args: string[];
  env: Record<string, string>;
}

interface AcpHttpMcpHeader {
  name: string;
  value: string;
}

interface AcpHttpMcpServer {
  type: 'http';
  name: string;
  url: string;
  headers: AcpHttpMcpHeader[];
}

interface AcpMcpServersInput {
  listenerPort: number | null;
  sessionId: string;
  agentToken: string | null;
  packServers: readonly PackMcpServer[];
  packEnv: Readonly<Record<string, string>>;
}

const NO_MCP_LAUNCH: McpLaunch = Object.freeze({ args: [], env: {} });

function mcpUrl(listenerPort: number): string {
  return `http://127.0.0.1:${listenerPort}/mcp`;
}

function claudeMcpArgs(glimmervoidUrl: string | null, packServers: readonly PackMcpServer[]): string[] {
  const packEntries = Object.fromEntries(packServers.map((server) => [server.name, { type: 'http', url: server.url, ...packHeaders(server) }]));
  if (glimmervoidUrl === null) return ['--mcp-config', JSON.stringify({ mcpServers: packEntries })];
  const glimmervoidEntry = { type: 'http', url: glimmervoidUrl, headers: bearerHeaders(MCP_CREDENTIAL_ENV), timeout: MCP_TOOL_TIMEOUT_SECONDS * 1000 };
  return ['--mcp-config', JSON.stringify({ mcpServers: { ...packEntries, [MCP_SERVER_NAME]: glimmervoidEntry } }), '--allowedTools', `mcp__${MCP_SERVER_NAME}`];
}

function codexPackServerArgs(server: PackMcpServer): string[] {
  const urlArgs = ['-c', `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`];
  if (server.secret === undefined) return urlArgs;
  return [...urlArgs, '-c', `mcp_servers.${server.name}.bearer_token_env_var=${JSON.stringify(packSecretEnvName(server.secret))}`];
}

function codexMcpArgs(glimmervoidUrl: string | null, packServers: readonly PackMcpServer[]): string[] {
  const packArgs = packServers.flatMap(codexPackServerArgs);
  if (glimmervoidUrl === null) return packArgs;
  const settings = [
    `url=${JSON.stringify(glimmervoidUrl)}`,
    `bearer_token_env_var=${JSON.stringify(MCP_CREDENTIAL_ENV)}`,
    'default_tools_approval_mode="approve"',
    `tool_timeout_sec=${MCP_TOOL_TIMEOUT_SECONDS}`,
    `tool_input_schema_max_bytes=${CODEX_TOOL_INPUT_SCHEMA_MAX_BYTES}`,
  ];
  return [...packArgs, ...settings.flatMap((setting) => ['-c', `mcp_servers.${MCP_SERVER_NAME}.${setting}`])];
}

function credentialOnly(): string[] {
  return [];
}

type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number];

const ARGS_BY_AGENT: Readonly<Partial<Record<BuiltinAgentId, (glimmervoidUrl: string | null, packServers: readonly PackMcpServer[]) => string[]>>> = Object.freeze({
  'claude-code': claudeMcpArgs,
  codex: codexMcpArgs,
  kimi: credentialOnly,
  opencode: credentialOnly,
  pi: credentialOnly,
  antigravity: credentialOnly,
  gemini: credentialOnly,
  qwen: credentialOnly,
  copilot: credentialOnly,
});

function bearerHeaders(envName: string): Record<string, string> {
  return { Authorization: `Bearer \${${envName}}` };
}

function packHeaders(server: PackMcpServer): { headers?: Record<string, string> } {
  return server.secret === undefined ? {} : { headers: bearerHeaders(packSecretEnvName(server.secret)) };
}

function settingsHomeMcpServers(listenerPort: number, packServers: readonly PackMcpServer[]): Record<string, unknown> {
  const packEntries = Object.fromEntries(packServers.map((server) => [server.name, { httpUrl: server.url, ...packHeaders(server) }]));
  const glimmervoidEntry = { httpUrl: mcpUrl(listenerPort), headers: bearerHeaders(MCP_CREDENTIAL_ENV), timeout: MCP_TOOL_TIMEOUT_SECONDS * 1000, trust: true };
  return { ...packEntries, [MCP_SERVER_NAME]: glimmervoidEntry };
}

function copilotMcpConfigText(listenerPort: number, packServers: readonly PackMcpServer[]): string {
  const packEntries = Object.fromEntries(packServers.map((server) => [server.name, { type: 'http', url: server.url, ...packHeaders(server), tools: ['*'] }]));
  const glimmervoidEntry = { type: 'http', url: mcpUrl(listenerPort), headers: bearerHeaders(MCP_CREDENTIAL_ENV), tools: ['*'] };
  return serversFileText({ ...packEntries, [MCP_SERVER_NAME]: glimmervoidEntry });
}

function copilotMcpArgs(mcpConfigPath: string): string[] {
  return ['--additional-mcp-config', `@${mcpConfigPath}`, `--allow-tool=${MCP_SERVER_NAME}`];
}

function copilotMcpConfigName(configText: string): string {
  return `glimmervoid-mcp-${createHash('sha256').update(configText).digest('hex').slice(0, 16)}.json`;
}

function qwenMcpArgs(sharedPackServers: readonly PackMcpServer[], packServers: readonly PackMcpServer[]): string[] {
  const sessionNames = new Set(packServers.map((server) => server.name));
  return sharedPackServers.filter((server) => !sessionNames.has(server.name)).map((server) => `--disable-mcp-server=${server.name}`);
}

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
  packServersJson: string | null;
  listenerPort: number;
  packServers: readonly PackMcpServer[];
}

function serversFileText(servers: McpServers): string {
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

interface LastPackServers {
  names: string[];
  shadowedServers: McpServers;
}

const NO_LAST_PACK_SERVERS: LastPackServers = Object.freeze({ names: [], shadowedServers: {} });

function packServersFileText(packServerNames: readonly string[], shadowedServers: McpServers): string {
  return `${JSON.stringify({ [KIMI_PACK_SERVER_NAMES_KEY]: packServerNames, [KIMI_SHADOWED_SERVERS_KEY]: shadowedServers }, null, 2)}\n`;
}

function lastPackServersOf(packServersJson: string | null): LastPackServers {
  if (packServersJson === null) return NO_LAST_PACK_SERVERS;
  try {
    const parsed: unknown = JSON.parse(packServersJson);
    if (typeof parsed !== 'object' || parsed === null) return NO_LAST_PACK_SERVERS;
    const names = KIMI_PACK_SERVER_NAMES_KEY in parsed ? parsed[KIMI_PACK_SERVER_NAMES_KEY] : [];
    const shadowedServers = KIMI_SHADOWED_SERVERS_KEY in parsed ? parsed[KIMI_SHADOWED_SERVERS_KEY] : {};
    return {
      names: Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [],
      shadowedServers: typeof shadowedServers === 'object' && shadowedServers !== null && !Array.isArray(shadowedServers) ? { ...shadowedServers } : {},
    };
  } catch {
    return NO_LAST_PACK_SERVERS;
  }
}

function withPackServersUndone(servers: McpServers, { names, shadowedServers }: LastPackServers): McpServers {
  const kept = Object.entries(servers).filter(([name]) => !names.includes(name));
  const restored = names.filter((name) => Object.hasOwn(shadowedServers, name)).map((name) => [name, shadowedServers[name]]);
  return Object.fromEntries([...kept, ...restored]);
}

function serversNamed(servers: McpServers, names: readonly string[]): McpServers {
  return Object.fromEntries(names.filter((name) => Object.hasOwn(servers, name)).map((name) => [name, servers[name]]));
}

function kimiMcpFiles({ realMcpJson, generatedMcpJson, baseMcpJson, packServersJson, listenerPort, packServers }: KimiMcpSources): Record<string, string> {
  const realServers = mcpServersOf(realMcpJson);
  const generatedServers = mcpServersOf(generatedMcpJson);
  const ours = generatedServers === null ? null : withPackServersUndone(withoutGlimmervoidServer(generatedServers), lastPackServersOf(packServersJson));
  const isRealFileUnreadable = realMcpJson !== null && realServers === null;
  const theirs = withoutGlimmervoidServer(realServers ?? {});
  const operatorServers = isRealFileUnreadable ? ours ?? {} : mergeOperatorServers(mcpServersOf(baseMcpJson), ours, theirs);
  const glimmervoidServer = {
    transport: 'http',
    url: mcpUrl(listenerPort),
    bearerTokenEnvVar: MCP_CREDENTIAL_ENV,
    toolTimeoutMs: MCP_TOOL_TIMEOUT_SECONDS * 1000,
  };
  const packEntries = Object.fromEntries(packServers.map((server) => [server.name, server.secret === undefined ? { transport: 'http', url: server.url } : { transport: 'http', url: server.url, bearerTokenEnvVar: packSecretEnvName(server.secret) }]));
  const packServerNames = packServers.map((server) => server.name);
  return {
    [KIMI_MCP_CONFIG_NAME]: serversFileText({ ...operatorServers, ...packEntries, [MCP_SERVER_NAME]: glimmervoidServer }),
    [KIMI_MCP_BASE_NAME]: isRealFileUnreadable ? baseMcpJson ?? serversFileText(operatorServers) : serversFileText(theirs),
    [KIMI_PACK_SERVERS_NAME]: packServersFileText(packServerNames, serversNamed(operatorServers, packServerNames)),
  };
}

const PACK_SERVER_AGENT_IDS: ReadonlySet<string> = new Set(['claude-code', 'codex', 'kimi', 'opencode', 'pi', 'antigravity', 'gemini', 'qwen', 'copilot']);

function rendersPackServers(agentId: string): boolean {
  return PACK_SERVER_AGENT_IDS.has(agentId);
}

function isBuiltinWithMcpArgs(agentId: string): agentId is keyof typeof ARGS_BY_AGENT {
  return Object.hasOwn(ARGS_BY_AGENT, agentId);
}

function acpPackServerOf(server: PackMcpServer, packEnv: Readonly<Record<string, string>>): AcpHttpMcpServer | null {
  if (server.secret === undefined) return { type: 'http', name: server.name, url: server.url, headers: [] };
  const secretValue = packEnv[packSecretEnvName(server.secret)];
  if (!secretValue) return null;
  return { type: 'http', name: server.name, url: server.url, headers: [{ name: 'Authorization', value: `Bearer ${secretValue}` }] };
}

function acpMcpServersFor({ listenerPort, sessionId, agentToken, packServers, packEnv }: AcpMcpServersInput): AcpHttpMcpServer[] {
  const servers = packServers.map((server) => acpPackServerOf(server, packEnv)).filter((server): server is AcpHttpMcpServer => server !== null);
  const hasGlimmervoidServer = listenerPort !== null && listenerPort > 0 && agentToken !== null && agentToken !== '';
  if (!hasGlimmervoidServer) return servers;
  return [
    ...servers,
    {
      type: 'http',
      name: MCP_SERVER_NAME,
      url: mcpUrl(listenerPort),
      headers: [{ name: 'Authorization', value: `Bearer ${mcpCredentialFor(sessionId, agentToken)}` }],
    },
  ];
}

interface AcpMcpEnvInput {
  agentId: string;
  listenerPort: number | null;
  agentToken: string | null;
}

function acpMcpEnvFor({ agentId, listenerPort, agentToken }: AcpMcpEnvInput): Record<string, string> {
  const hasGlimmervoidServer = listenerPort !== null && listenerPort > 0 && agentToken !== null && agentToken !== '';
  if (!hasGlimmervoidServer || agentId !== 'claude-code') return {};
  return { [CLAUDE_MCP_TOOL_TIMEOUT_ENV]: String(MCP_TOOL_TIMEOUT_SECONDS * 1000) };
}

function mcpLaunchFor({ agentId, listenerPort, sessionId, agentToken, packServers }: McpLaunchInput): McpLaunch {
  const buildArgs = isBuiltinWithMcpArgs(agentId) ? ARGS_BY_AGENT[agentId] : undefined;
  if (!buildArgs) return NO_MCP_LAUNCH;
  const hasGlimmervoidServer = listenerPort !== null && listenerPort > 0 && agentToken !== null && agentToken !== '';
  if (!hasGlimmervoidServer && packServers.length === 0) return NO_MCP_LAUNCH;
  return {
    args: buildArgs(hasGlimmervoidServer ? mcpUrl(listenerPort) : null, packServers),
    env: hasGlimmervoidServer ? { [MCP_CREDENTIAL_ENV]: mcpCredentialFor(sessionId, agentToken) } : {},
  };
}

export { KIMI_MCP_BASE_NAME, KIMI_MCP_CONFIG_NAME, KIMI_PACK_SERVERS_NAME, MCP_CREDENTIAL_ENV, MCP_TOOL_TIMEOUT_SECONDS, MCP_URL_ENV, PACK_SECRET_ENV_PREFIX, acpMcpEnvFor, acpMcpServersFor, copilotMcpArgs, copilotMcpConfigName, copilotMcpConfigText, kimiMcpFiles, mcpLaunchFor, packSecretEnvName, qwenMcpArgs, rendersPackServers, settingsHomeMcpServers };
export type { AcpHttpMcpHeader, AcpHttpMcpServer, AcpMcpEnvInput, AcpMcpServersInput, McpLaunch, McpLaunchInput };
