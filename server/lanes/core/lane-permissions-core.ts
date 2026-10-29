import { isRecord } from '../../../shared/coerce.ts';
import type { ResolvedHookTool } from '../../../session/core/hook-tools.ts';
import { definesHooksOutsideArrayTables } from '../../../session/core/kimi-hooks-block-core.ts';
import type { GuardrailsRole } from '../../guardrails/core/guardrails-policy-core.ts';

const ACCEPT_EDITS_MODE = 'acceptEdits';

const LANE_CONFIG_EDIT_DENY_RULES: readonly string[] = Object.freeze([
  'Edit(**/.git/**)',
  'Edit(**/.claude/**)',
]);

const LANE_ENVIRONMENT_ARGS: readonly string[] = Object.freeze([
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--setting-sources', 'project,local',
]);

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
const POSTHOG_OAUTH_HOST = 'oauth.posthog.com';
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
  networkDomains: string[];
  bypassHookTrust: boolean;
  launchHomeFiles: NonNullable<GuardrailsRole['launchHomeFiles']>;
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
    networkDomains: [POSTHOG_MCP_HOST, POSTHOG_OAUTH_HOST],
    bypassHookTrust: false,
    launchHomeFiles: {},
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
    networkDomains: [POSTHOG_MCP_HOST, POSTHOG_OAUTH_HOST],
    bypassHookTrust: true,
    launchHomeFiles: {},
  };
}

function kimiLaneMcpConfig(server: LaneMcpServer): { mcpServers: Record<string, Record<string, unknown>> } {
  return { mcpServers: { [server.name]: { ...server.entry, enabledTools: ['exec'] } } };
}

function kimiLaneConfigText(operatorConfigText: string, gateHook: { matcher: string; command: string }): string | null {
  if (definesHooksOutsideArrayTables(operatorConfigText) || /['\r\n]/.test(gateHook.command)) return null;
  const separator = operatorConfigText === '' || operatorConfigText.endsWith('\n') ? '' : '\n';
  return `${operatorConfigText}${separator}\n[[hooks]]\nevent = "PreToolUse"\nmatcher = '${gateHook.matcher}'\ncommand = '${gateHook.command}'\n`;
}

function keepsKimiToolName(serverName: string): boolean {
  return !serverName.includes('__') && `mcp__${serverName}__exec`.length <= KIMI_QUALIFIED_TOOL_NAME_MAX_LENGTH;
}

function kimiLaneMcpPosture({ server, mcpConfigPath, configPath, gatePath, interpreterPath }: {
  server: LaneMcpServer; mcpConfigPath: string; configPath: string; gatePath: string; interpreterPath: string;
}): LaneMcpPosture | null {
  if (!keepsKimiToolName(server.name)) return null;
  const hookTool = gatedPosthogTool({ server, gatePath, interpreterPath });
  if (!hookTool) return null;
  return {
    args: [],
    allowRules: [],
    hookTool,
    networkDomains: [POSTHOG_MCP_HOST, POSTHOG_OAUTH_HOST],
    bypassHookTrust: false,
    launchHomeFiles: { kimi: { 'mcp.json': mcpConfigPath, 'config.toml': configPath } },
  };
}

function withNetworkDomains(role: GuardrailsRole, domains: readonly string[]): GuardrailsRole {
  if (role.network.access !== 'allowlist' || domains.length === 0) return role;
  return { ...role, network: { ...role.network, domains: [...new Set([...role.network.domains, ...domains])] } };
}

function withLaneMcp(role: GuardrailsRole, posture: LaneMcpPosture | undefined): GuardrailsRole {
  if (!posture) return role;
  return { ...withNetworkDomains(role, posture.networkDomains), launchHomeFiles: { ...role.launchHomeFiles, ...posture.launchHomeFiles } };
}

function withAllowRules(permissions: Record<string, unknown>, allowRules: readonly string[]): Record<string, unknown> {
  if (allowRules.length === 0) return permissions;
  const existingAllowRules = Array.isArray(permissions.allow) ? permissions.allow : [];
  return { ...permissions, allow: [...existingAllowRules, ...allowRules] };
}

export {
  ACCEPT_EDITS_MODE, LANE_CONFIG_EDIT_DENY_RULES, LANE_ENVIRONMENT_ARGS, buildLanePermissions,
  codexLaneMcpPosture, codexMcpServers, findPosthogServer, kimiLaneConfigText, kimiLaneMcpConfig, kimiLaneMcpPosture, laneMcpConfig, laneMcpPosture,
  withAllowRules, withLaneMcp,
};
export type { LaneMcpPosture };
