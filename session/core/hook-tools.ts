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
  serverName?: string;
  interpreterPath?: string;
}

interface HookToolDescriptor {
  capability: 'saneYolo' | 'hooks';
  purpose: string;
  env(tool: ResolvedHookTool, homeDir: string): Record<string, string>;
  claudeEntry(tool: ResolvedHookTool, relayPath: string): ClaudeHookEntry;
  codexGroup(tool: ResolvedHookTool, relayPath: string): string | null;
  codexTrustedArgs(tool: ResolvedHookTool): string[];
}

function codexGroup(command: string | null, matcher = 'Bash'): string | null {
  if (!command) return null;
  return `{matcher='${matcher}',hooks=[{type='command',command='${command}'}]}`;
}

function posthogToolMatcher(tool: ResolvedHookTool): string {
  return `^mcp__${tool.serverName ?? ''}__`;
}

function posthogGateCommand(tool: ResolvedHookTool): string {
  return `"${toForwardSlashes(tool.interpreterPath ?? 'node')}" "${toForwardSlashes(tool.binPath)}" ${tool.serverName ?? ''} || exit 2`;
}

const HOOK_TOOLS: Record<HookToolId, HookToolDescriptor> = {
  saneYolo: {
    capability: 'saneYolo',
    purpose: 'Sane YOLO catastrophic command protection',
    env: (tool, homeDir) => ({ [SANE_YOLO_PATH_ENV]: tool.binPath, ...saneYoloEnv(homeDir) }),
    claudeEntry: (tool) => ({
      matcher: 'Bash|PowerShell|Monitor|Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep',
      hooks: [{ type: 'command', command: `node "${toForwardSlashes(tool.binPath)}" hook --coding-cli` }],
    }),
    codexGroup: (tool) => codexGroup(buildHookCommand(tool.binPath, 'hook', ['--codex'])),
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

export { HOOK_TOOLS, mergeCodexPreToolUse };
export type { ResolvedHookTool };
