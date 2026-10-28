import { buildHookCommand } from './hook-command-core.ts';
import { SANE_YOLO_PATH_ENV, saneYoloEnv } from './sane-yolo.ts';

interface ClaudeHookEntry {
  matcher: string;
  hooks: { type: string; command: string }[];
}

function toForwardSlashes(commandPath: string): string {
  return commandPath.replace(/\\/g, '/');
}

type HookToolId = 'saneYolo';
interface ResolvedHookTool {
  id: HookToolId;
  binPath: string;
}

interface HookToolDescriptor {
  capability: HookToolId;
  purpose: string;
  env(tool: ResolvedHookTool, homeDir: string): Record<string, string>;
  claudeEntry(tool: ResolvedHookTool, relayPath: string): ClaudeHookEntry;
  codexGroup(tool: ResolvedHookTool, relayPath: string): string | null;
}

function codexGroup(command: string | null): string | null {
  if (!command) return null;
  return `{matcher='Bash',hooks=[{type='command',command='${command}'}]}`;
}

const HOOK_TOOLS: Record<HookToolId, HookToolDescriptor> = {
  saneYolo: {
    capability: 'saneYolo',
    purpose: 'Sane YOLO catastrophic command protection',
    env: (tool, homeDir) => ({ [SANE_YOLO_PATH_ENV]: tool.binPath, ...saneYoloEnv(homeDir) }),
    claudeEntry: (tool) => ({
      matcher: 'Bash|PowerShell|Monitor',
      hooks: [{ type: 'command', command: `node "${toForwardSlashes(tool.binPath)}" hook --coding-cli` }],
    }),
    codexGroup: (tool) => codexGroup(buildHookCommand(tool.binPath, 'hook', ['--codex'])),
  },
};

function mergeCodexPreToolUse(groups: readonly string[]): string[] {
  if (groups.length === 0) return [];
  return ['-c', `hooks.PreToolUse=[${groups.join(',')}]`];
}

export { HOOK_TOOLS, mergeCodexPreToolUse };
export type { HookToolId, ResolvedHookTool };
