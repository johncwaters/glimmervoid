import { isRecord } from '../../../shared/coerce.ts';
import { HOOK_TOOLS } from '../../../session/core/hook-tools.ts';
import type { ResolvedHookTool } from '../../../session/core/hook-tools.ts';

const ACCEPT_EDITS_MODE = 'acceptEdits';

const LANE_CREDENTIAL_ENV: Readonly<Record<string, string>> = Object.freeze({
  SSH_AUTH_SOCK: '', SSH_ASKPASS: '', GIT_ASKPASS: '', GIT_SSH_COMMAND: 'false', GIT_TERMINAL_PROMPT: '0',
  GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '',
});

const LANE_CONFIG_EDIT_DENY_RULES: readonly string[] = Object.freeze([
  'Edit(**/.git/**)',
  'Edit(**/.claude/**)',
]);

const LANE_ENVIRONMENT_ARGS: readonly string[] = Object.freeze([
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--setting-sources', 'project,local',
]);

const READ_ONLY_GIT_SUBCOMMANDS: readonly string[] = Object.freeze([
  'diff', 'log', 'show', 'merge-base', 'range-diff', 'rev-parse', 'blame', 'ls-files', 'cat-file',
]);

function readOnlyGitAllowRules(checkoutPath: string, envPrefixes: readonly string[] = []): string[] {
  const commandPrefixes = ['', ...envPrefixes.map((envPrefix) => `${envPrefix} `)];
  return commandPrefixes.flatMap((commandPrefix) => READ_ONLY_GIT_SUBCOMMANDS.map((subcommand) => `Bash(${commandPrefix}git -C ${checkoutPath} ${subcommand}:*)`));
}

interface LanePermissions {
  permissions: { deny: string[]; defaultMode: string };
  args: string[];
}

function buildLanePermissions({
  denyTools = [],
  allowTools = [],
}: { denyTools?: readonly string[]; allowTools?: readonly string[] } = {}): LanePermissions {
  const args: string[] = [];
  if (allowTools.length > 0) args.push('--tools', allowTools.join(','));
  args.push(...LANE_ENVIRONMENT_ARGS);
  return { permissions: { deny: [...denyTools], defaultMode: ACCEPT_EDITS_MODE }, args };
}

const POSTHOG_MCP_HOST = 'mcp.posthog.com';
const OPEN_LANE_AGENT_ID = 'claude-code';
const DEFAULT_LANE_FETCH_DOMAINS: readonly string[] = Object.freeze([
  'github.com', 'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com', 'posthog.com',
]);
const LANE_EGRESS_REFUSED_PROXY = 'http://127.0.0.1:9';
const LANE_PROXY_KEYS: readonly string[] = Object.freeze(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']);
const LANE_AGENT_HOSTS: readonly string[] = Object.freeze([
  'localhost', '127.0.0.1', '::1', 'anthropic.com', '.anthropic.com', 'claude.ai', '.claude.ai', 'claude.com', '.claude.com', POSTHOG_MCP_HOST,
]);
const CLOSED_LANE_DENY_RULES: readonly string[] = Object.freeze(['Bash(gh:*)', 'WebFetch', 'WebSearch', 'Bash(curl:*)', 'Bash(wget:*)']);
const OPEN_LANE_DENY_RULES: readonly string[] = Object.freeze([
  'Bash(curl:*)', 'Bash(wget:*)', 'Bash(gh auth:*)', 'Bash(gh config:*)', 'Bash(gh alias:*)',
  'Bash(gh extension:*)', 'Bash(gh extensions:*)', 'Bash(gh ext:*)', 'Bash(gh codespace:*)', 'Bash(gh cs:*)',
  'Bash(gh copilot:*)', 'Bash(gh browse:*)', 'Bash(gh repo clone:*)', 'Bash(gh repo fork:*)', 'Bash(gh repo create:*)',
  'Bash(gh gist clone:*)', 'Bash(gh pr checkout:*)', 'Bash(gh co:*)',
]);
const ALTERNATE_MODEL_PROVIDER_KEYS: readonly string[] = Object.freeze(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']);
const OPEN_LANE_TOOLS: readonly string[] = Object.freeze(['Bash', 'WebFetch', 'WebSearch']);

interface LaneAccessInput {
  agent: string;
  readToken: string | null;
  extraFetchDomains: readonly string[];
  ghConfigDir: string;
  inheritedEnv: Readonly<Record<string, string | undefined>>;
}

interface LaneAccess {
  isOpen: boolean;
  env: Record<string, string>;
  allowRules: string[];
  denyRules: string[];
  tools: string[];
}

function laneAccessEnvBlocker(inheritedEnv: Readonly<Record<string, string | undefined>>): string | null {
  return [...LANE_PROXY_KEYS, ...ALTERNATE_MODEL_PROVIDER_KEYS].find((key) => (inheritedEnv[key] ?? '').length > 0) ?? null;
}

function laneFetchDomains(extraFetchDomains: readonly string[]): string[] {
  return [...new Set([...DEFAULT_LANE_FETCH_DOMAINS, ...extraFetchDomains])];
}

function egressBlockEnv(fetchDomains: readonly string[], inheritedEnv: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const anthropicBaseHost = urlHostname(inheritedEnv.ANTHROPIC_BASE_URL);
  const reachableHosts = [...fetchDomains, ...LANE_AGENT_HOSTS, ...(anthropicBaseHost ? [anthropicBaseHost] : [])].join(',');
  const proxyEnv = Object.fromEntries(LANE_PROXY_KEYS.map((key) => [key, LANE_EGRESS_REFUSED_PROXY]));
  return { ...proxyEnv, NO_PROXY: reachableHosts, no_proxy: reachableHosts };
}

interface LaneAccessConfig {
  readToken: string | null;
  extraFetchDomains: readonly string[];
}

const CLOSED_LANE_ACCESS_CONFIG: LaneAccessConfig = Object.freeze({ readToken: null, extraFetchDomains: Object.freeze([]) });

function laneAccessConfigOf(config: { github?: { readToken?: string } | null; lanes?: { fetchDomains?: readonly string[] } | null }): LaneAccessConfig {
  return { readToken: config.github?.readToken || null, extraFetchDomains: config.lanes?.fetchDomains ?? [] };
}

function laneAccess({ agent, readToken, extraFetchDomains, ghConfigDir, inheritedEnv }: LaneAccessInput): LaneAccess {
  const ghEnv = { ...LANE_CREDENTIAL_ENV, GH_CONFIG_DIR: ghConfigDir, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  const isOpen = agent === OPEN_LANE_AGENT_ID && Boolean(readToken) && laneAccessEnvBlocker(inheritedEnv) === null;
  if (!isOpen || !readToken) return { isOpen: false, env: ghEnv, allowRules: [], denyRules: [...CLOSED_LANE_DENY_RULES], tools: [] };
  const fetchDomains = laneFetchDomains(extraFetchDomains);
  return {
    isOpen: true,
    env: { ...ghEnv, GH_TOKEN: readToken, ...egressBlockEnv(fetchDomains, inheritedEnv) },
    allowRules: ['Bash(gh:*)', 'WebSearch', ...fetchDomains.map((domain) => `WebFetch(domain:${domain})`)],
    denyRules: [...OPEN_LANE_DENY_RULES],
    tools: [...OPEN_LANE_TOOLS],
  };
}

const MCP_SERVER_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CODEX_MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
const KIMI_QUALIFIED_TOOL_NAME_MAX_LENGTH = 64;
const STRICT_MCP_CONFIG_ARG = '--strict-mcp-config';
const HOOK_COMMAND_SAFE_PATH_RE = /^[A-Za-z0-9_.:/\\ -]+$/;

interface LaneMcpServer {
  name: string;
  entry: Record<string, unknown>;
}

interface LaneMcpPosture {
  args: string[];
  allowRules: string[];
  hookTool: ResolvedHookTool;
  bypassHookTrust: boolean;
  laneHome: { configSuffix: string; files: Record<string, string> } | null;
}

function urlHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

function findPosthogServer(servers: unknown): LaneMcpServer | null {
  if (!isRecord(servers)) return null;
  for (const [name, entry] of Object.entries(servers)) {
    if (!MCP_SERVER_NAME_RE.test(name) || !isRecord(entry)) continue;
    if (urlHostname(entry.url) === POSTHOG_MCP_HOST) return { name, entry };
  }
  return null;
}

function laneMcpConfig(server: LaneMcpServer): { mcpServers: Record<string, Record<string, unknown>> } {
  return { mcpServers: { [server.name]: server.entry } };
}

function codexMcpServers(mcpListOutput: unknown): Record<string, Record<string, unknown>> {
  if (!Array.isArray(mcpListOutput)) return {};
  const enabledServers = mcpListOutput.filter((server) => isRecord(server) && server.enabled === true && typeof server.name === 'string' && isRecord(server.transport));
  return Object.fromEntries(enabledServers.map((server) => [server.name, server.transport]));
}

function gatedPosthogTool({ server, gatePath, interpreterPath }: { server: LaneMcpServer; gatePath: string; interpreterPath: string }): ResolvedHookTool | null {
  if (![gatePath, interpreterPath].every((commandPath) => HOOK_COMMAND_SAFE_PATH_RE.test(commandPath))) return null;
  return { id: 'posthogReadGate', binPath: gatePath, serverName: server.name, interpreterPath };
}

function laneMcpPosture({ server, mcpConfigPath, gatePath, interpreterPath, laneArgs }: {
  server: LaneMcpServer; mcpConfigPath: string; gatePath: string; interpreterPath: string; laneArgs: readonly string[];
}): LaneMcpPosture | null {
  const hookTool = gatedPosthogTool({ server, gatePath, interpreterPath });
  if (!hookTool) return null;
  const loadsOnlyListedServers = laneArgs.includes(STRICT_MCP_CONFIG_ARG);
  return {
    args: loadsOnlyListedServers ? ['--mcp-config', mcpConfigPath] : [],
    allowRules: [`mcp__${server.name}__exec`],
    hookTool,
    bypassHookTrust: false,
    laneHome: null,
  };
}

function codexLaneMcpPosture({ server, otherServerNames, gatePath, interpreterPath }: {
  server: LaneMcpServer; otherServerNames: readonly string[]; gatePath: string; interpreterPath: string;
}): LaneMcpPosture | null {
  const hookTool = gatedPosthogTool({ server, gatePath, interpreterPath });
  if (!hookTool || !otherServerNames.every((name) => CODEX_MCP_SERVER_NAME_RE.test(name))) return null;
  const disabledServerArgs = otherServerNames.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]);
  return {
    args: ['-c', `mcp_servers.${server.name}.enabled_tools=["exec"]`, ...disabledServerArgs],
    allowRules: [],
    hookTool,
    bypassHookTrust: true,
    laneHome: null,
  };
}

function kimiLaneMcpConfig(server: LaneMcpServer): { mcpServers: Record<string, Record<string, unknown>> } {
  return { mcpServers: { [server.name]: { ...server.entry, enabledTools: ['exec'] } } };
}

function kimiGateHookTable(gateHook: { matcher: string; command: string }): string | null {
  if (/['\r\n]/.test(gateHook.command)) return null;
  return `\n[[hooks]]\nevent = "PreToolUse"\nmatcher = '${gateHook.matcher}'\ncommand = '${gateHook.command}'\n`;
}

function keepsKimiToolName(serverName: string): boolean {
  return !serverName.includes('__') && `mcp__${serverName}__exec`.length <= KIMI_QUALIFIED_TOOL_NAME_MAX_LENGTH;
}

function kimiLaneMcpPosture({ server, gatePath, interpreterPath }: {
  server: LaneMcpServer; gatePath: string; interpreterPath: string;
}): LaneMcpPosture | null {
  if (!keepsKimiToolName(server.name)) return null;
  const hookTool = gatedPosthogTool({ server, gatePath, interpreterPath });
  if (!hookTool) return null;
  const gateHook = HOOK_TOOLS.posthogReadGate.claudeEntry(hookTool, '');
  const gateHookTable = kimiGateHookTable({ matcher: gateHook.matcher, command: gateHook.hooks[0]?.command ?? '' });
  if (gateHookTable === null) return null;
  return {
    args: [],
    allowRules: [],
    hookTool,
    bypassHookTrust: false,
    laneHome: { configSuffix: gateHookTable, files: { 'mcp.json': `${JSON.stringify(kimiLaneMcpConfig(server), null, 2)}\n` } },
  };
}

function withAllowRules(permissions: Record<string, unknown>, allowRules: readonly string[]): Record<string, unknown> {
  if (allowRules.length === 0) return permissions;
  const existingAllowRules = Array.isArray(permissions.allow) ? permissions.allow : [];
  return { ...permissions, allow: [...existingAllowRules, ...allowRules] };
}

function withLaneAccessRules(permissions: Record<string, unknown>, access: Pick<LaneAccess, 'allowRules' | 'denyRules'>): Record<string, unknown> {
  const existingDenyRules = Array.isArray(permissions.deny) ? permissions.deny : [];
  const deny = [...new Set([...existingDenyRules, ...access.denyRules])];
  return withAllowRules({ ...permissions, deny }, access.allowRules);
}

export {
  ACCEPT_EDITS_MODE, CLOSED_LANE_ACCESS_CONFIG, LANE_CONFIG_EDIT_DENY_RULES, LANE_ENVIRONMENT_ARGS, READ_ONLY_GIT_SUBCOMMANDS, buildLanePermissions,
  codexLaneMcpPosture, codexMcpServers, findPosthogServer, kimiLaneMcpPosture, laneAccess, laneAccessConfigOf, laneAccessEnvBlocker, laneMcpConfig, laneMcpPosture,
  readOnlyGitAllowRules, withAllowRules, withLaneAccessRules,
};
export type { LaneAccess, LaneAccessConfig, LaneMcpPosture };
