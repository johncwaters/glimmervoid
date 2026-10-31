import { compareSemver } from '../../server/core/update-core.ts';

interface MatchedRelayHook {
  event: string;
  matcher: string;
  isAsync?: boolean;
}

interface CodexHookPlan {
  events: string[];
  matchedRelayHooks: readonly MatchedRelayHook[];
  gatesMcpToolCalls: boolean;
}

const CODEX_EXTENDED_HOOKS_FLOOR = '0.163.0';
const CODEX_MCP_PRE_TOOL_USE_FLOOR = '0.165.0';

const LEGACY_HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PermissionRequest'];
const EXTENDED_HOOK_EVENTS = [...LEGACY_HOOK_EVENTS, 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop'];
const EXTENDED_MATCHED_RELAY_HOOKS: readonly MatchedRelayHook[] = [
  { event: 'PreToolUse', matcher: 'request_user_input' },
  { event: 'PostToolUse', matcher: 'Bash', isAsync: true },
  { event: 'PostToolUse', matcher: 'request_user_input' },
];

const CODEX_VERSION_RE = /\bcodex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;
const PRERELEASE_SUFFIX_RE = /^[^+]*-/;

function parseCodexVersion(versionOutput: unknown): string | null {
  if (typeof versionOutput !== 'string') return null;
  return CODEX_VERSION_RE.exec(versionOutput)?.[1] ?? null;
}

function isAtOrAbove(installedVersion: string | null, floor: string): boolean {
  if (installedVersion === null) return false;
  const releaseOrder = compareSemver(installedVersion, floor);
  if (releaseOrder !== 0) return releaseOrder > 0;
  return !PRERELEASE_SUFFIX_RE.test(installedVersion);
}

function codexHookPlanFor(installedVersion: string | null): CodexHookPlan {
  const gatesMcpToolCalls = isAtOrAbove(installedVersion, CODEX_MCP_PRE_TOOL_USE_FLOOR);
  if (!isAtOrAbove(installedVersion, CODEX_EXTENDED_HOOKS_FLOOR)) return { events: [...LEGACY_HOOK_EVENTS], matchedRelayHooks: [], gatesMcpToolCalls };
  return { events: [...EXTENDED_HOOK_EVENTS], matchedRelayHooks: EXTENDED_MATCHED_RELAY_HOOKS, gatesMcpToolCalls };
}

export { LEGACY_HOOK_EVENTS, parseCodexVersion, codexHookPlanFor };
export type { CodexHookPlan, MatchedRelayHook };
