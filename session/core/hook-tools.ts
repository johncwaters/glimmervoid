import { buildHookCommand } from './hook-command-core.ts';
import { SANE_YOLO_PATH_ENV, saneYoloEnv } from './sane-yolo.ts';

interface ClaudeHookEntry {
  matcher: string;
  hooks: { type: string; command: string }[];
}

function toForwardSlashes(commandPath: string): string {
  return commandPath.replace(/\\/g, '/');
}

type HookToolId = 'saneYolo' | 'posthogReadGate';
interface ResolvedHookTool {
  id: HookToolId;
  binPath: string;
  launch: readonly string[];
  serverName?: string;
}

interface HookToolDescriptor {
  capability: 'saneYolo' | 'hooks';
  purpose: string;
  env(tool: ResolvedHookTool, homeDir: string): Record<string, string>;
  claudeEntry(tool: ResolvedHookTool): ClaudeHookEntry;
  codexGroup(tool: ResolvedHookTool): string | null;
  codexTrustedArgs(tool: ResolvedHookTool): string[];
}

function codexGroup(command: string | null, matcher = 'Bash'): string | null {
  if (!command) return null;
  return `{matcher='${matcher}',hooks=[{type='command',command='${command}'}]}`;
}

function posthogToolMatcher(tool: ResolvedHookTool): string {
  return `^mcp__${tool.serverName ?? ''}__`;
}

function doubleQuoted(commandPart: string): string {
  return `"${toForwardSlashes(commandPart)}"`;
}

function posthogGateCommand(tool: ResolvedHookTool): string {
  return `${tool.launch.map(doubleQuoted).join(' ')} ${tool.serverName ?? ''} || exit 2`;
}

function saneYoloClaudeCommand(tool: ResolvedHookTool): string {
  const [launcher = '', ...launchArguments] = tool.launch;
  const launcherText = /^[A-Za-z0-9_.-]+$/.test(launcher) ? launcher : doubleQuoted(launcher);
  return [launcherText, ...launchArguments.map(doubleQuoted), 'hook', '--coding-cli'].join(' ');
}

const HOOK_TOOLS: Record<HookToolId, HookToolDescriptor> = {
  saneYolo: {
    capability: 'saneYolo',
    purpose: 'Sane YOLO catastrophic command protection',
    env: (tool, homeDir) => ({ [SANE_YOLO_PATH_ENV]: tool.binPath, ...saneYoloEnv(homeDir) }),
    claudeEntry: (tool) => ({
      matcher: 'Bash|PowerShell|Monitor|Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep',
      hooks: [{ type: 'command', command: saneYoloClaudeCommand(tool) }],
    }),
    codexGroup: (tool) => codexGroup(buildHookCommand(tool.launch, 'hook', ['--codex'])),
    codexTrustedArgs: () => [],
  },
  posthogReadGate: {
    capability: 'hooks',
    purpose: 'Read-only PostHog MCP access for lanes',
    env: () => ({}),
    claudeEntry: (tool) => ({
      matcher: posthogToolMatcher(tool),
      hooks: [{ type: 'command', command: posthogGateCommand(tool) }],
    }),
    codexGroup: (tool) => codexGroup(posthogGateCommand(tool), posthogToolMatcher(tool)),
    codexTrustedArgs: (tool) => ['-c', 'features.hooks=true', '-c', `mcp_servers.${tool.serverName ?? ''}.default_tools_approval_mode="approve"`],
  },
};

function mergeCodexPreToolUse(groups: readonly string[]): string[] {
  if (groups.length === 0) return [];
  return ['-c', `hooks.PreToolUse=[${groups.join(',')}]`];
}

function isHookToolId(name: string): name is HookToolId {
  return Object.hasOwn(HOOK_TOOLS, name);
}

export { HOOK_TOOLS, isHookToolId, mergeCodexPreToolUse };
export type { ResolvedHookTool };
