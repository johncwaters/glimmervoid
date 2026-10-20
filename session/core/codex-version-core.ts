import { compareSemver } from '../../server/core/update-core.ts';

interface MatchedRelayHook {
  event: string;
  matcher: string;
}

interface CodexHookPlan {
  events: string[];
  matchedRelayHooks: readonly MatchedRelayHook[];
}

const CODEX_EXTENDED_HOOKS_FLOOR = '0.163.0';

const LEGACY_HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PermissionRequest'];
const EXTENDED_HOOK_EVENTS = [...LEGACY_HOOK_EVENTS, 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop'];
const EXTENDED_MATCHED_RELAY_HOOKS: readonly MatchedRelayHook[] = [
  { event: 'PreToolUse', matcher: 'request_user_input' },
  { event: 'PostToolUse', matcher: 'Bash' },
];

const CODEX_VERSION_RE = /\bcodex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/;
const PRERELEASE_SUFFIX_RE = /^[^+]*-/;

function parseCodexVersion(versionOutput: unknown): string | null {
  if (typeof versionOutput !== 'string') return null;
  return CODEX_VERSION_RE.exec(versionOutput)?.[1] ?? null;
}

function isAtOrAboveExtendedHooksFloor(installedVersion: string): boolean {
  const releaseOrder = compareSemver(installedVersion, CODEX_EXTENDED_HOOKS_FLOOR);
  if (releaseOrder !== 0) return releaseOrder > 0;
  return !PRERELEASE_SUFFIX_RE.test(installedVersion);
}

function codexHookPlanFor(installedVersion: string | null): CodexHookPlan {
  const isExtended = installedVersion !== null && isAtOrAboveExtendedHooksFloor(installedVersion);
  if (!isExtended) return { events: [...LEGACY_HOOK_EVENTS], matchedRelayHooks: [] };
  return { events: [...EXTENDED_HOOK_EVENTS], matchedRelayHooks: EXTENDED_MATCHED_RELAY_HOOKS };
}

export { LEGACY_HOOK_EVENTS, parseCodexVersion, codexHookPlanFor };
export type { CodexHookPlan, MatchedRelayHook };
