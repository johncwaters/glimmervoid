import { isRecord } from '../../../shared/coerce.ts';
import type { ResolvedHookTool } from '../../../session/core/hook-tools.ts';
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

function laneMcpPosture({ server, mcpConfigPath, gatePath, interpreterPath, laneArgs }: {
  server: LaneMcpServer; mcpConfigPath: string; gatePath: string; interpreterPath: string; laneArgs: readonly string[];
}): LaneMcpPosture | null {
  if (![gatePath, interpreterPath].every((commandPath) => HOOK_COMMAND_SAFE_PATH_RE.test(commandPath))) return null;
  const loadsOnlyListedServers = laneArgs.includes(STRICT_MCP_CONFIG_ARG);
  return {
    args: loadsOnlyListedServers ? ['--mcp-config', mcpConfigPath] : [],
    allowRules: [`mcp__${server.name}__exec`],
    hookTool: { id: 'posthogReadGate', binPath: gatePath, serverName: server.name, interpreterPath },
    networkDomains: [POSTHOG_MCP_HOST, POSTHOG_OAUTH_HOST],
  };
}

function withNetworkDomains(role: GuardrailsRole, domains: readonly string[]): GuardrailsRole {
  if (role.network.access !== 'allowlist' || domains.length === 0) return role;
  return { ...role, network: { ...role.network, domains: [...new Set([...role.network.domains, ...domains])] } };
}

function withAllowRules(permissions: Record<string, unknown>, allowRules: readonly string[]): Record<string, unknown> {
  if (allowRules.length === 0) return permissions;
  const existingAllowRules = Array.isArray(permissions.allow) ? permissions.allow : [];
  return { ...permissions, allow: [...existingAllowRules, ...allowRules] };
}

export {
  ACCEPT_EDITS_MODE, LANE_CONFIG_EDIT_DENY_RULES, LANE_ENVIRONMENT_ARGS, buildLanePermissions,
  findPosthogServer, laneMcpConfig, laneMcpPosture, withAllowRules, withNetworkDomains,
};
export type { LaneMcpPosture };
