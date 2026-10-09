import path from 'node:path';
import { buildHookCommand } from './hook-command-core.ts';
import { RTK_PATH_ENV } from './rtk-hook-core.ts';
import { SANE_YOLO_PATH_ENV, saneYoloEnv } from './sane-yolo.ts';

import { resolvePathCommandMatches } from './spawn-command.ts';
import type { PathLookupExec } from './spawn-command.ts';

interface StatApi {
  statSync: (path: string) => { isFile: () => boolean };
}

interface RtkPathInputs {
  glimmervoidHome: string;
  platform: NodeJS.Platform;
  exec: PathLookupExec;
  fsApi: StatApi;
}

interface RtkHookEntry {
  matcher: string;
  hooks: { type: string; command: string }[];
}

function firstExistingFile(candidates: readonly string[], fsApi: StatApi): string | null {
  for (const candidate of candidates) {
    try {
      if (fsApi.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
    }
  }
  return null;
}

function resolveRtkPath({ glimmervoidHome, platform, exec, fsApi }: RtkPathInputs): string | null {
  const bundledCandidates = [
    path.join(glimmervoidHome, 'bin', 'rtk.exe'),
    path.join(glimmervoidHome, 'bin', 'rtk'),
  ];
  const bundled = firstExistingFile(bundledCandidates, fsApi);
  if (bundled) return bundled;

  const matches = resolvePathCommandMatches('rtk', { platform, exec });
  const firstMatch = matches[0];
  if (!firstMatch) return null;
  return path.resolve(firstMatch);
}

function quoteCommandPath(commandPath: string): string {
  if (!/\s/.test(commandPath)) return commandPath;
  return `"${commandPath}"`;
}

function toForwardSlashes(commandPath: string): string {
  return commandPath.replace(/\\/g, '/');
}

function buildRtkHookEntry(rtkPath: string): RtkHookEntry {
  const command = `${quoteCommandPath(toForwardSlashes(rtkPath))} hook claude`;
  return {
    matcher: 'Bash',
    hooks: [{ type: 'command', command }],
  };
}

export { resolveRtkPath, buildRtkHookEntry };
export type { RtkHookEntry, RtkPathInputs, StatApi };

type HookToolId = 'rtk' | 'saneYolo';
interface ResolvedHookTool {
  id: HookToolId;
  binPath: string;
}

interface HookToolDescriptor {
  capability: HookToolId;
  purpose: string;
  env(tool: ResolvedHookTool, homeDir: string): Record<string, string>;
  claudeEntry(tool: ResolvedHookTool): RtkHookEntry;
  codexGroup(tool: ResolvedHookTool, relayPath: string): string | null;
}

function codexGroup(command: string | null): string | null {
  if (!command) return null;
  return `{matcher='Bash',hooks=[{type='command',command='${command}'}]}`;
}

const HOOK_TOOLS: Record<HookToolId, HookToolDescriptor> = {
  rtk: {
    capability: 'rtk',
    purpose: 'rtk command rewriting',
    env: (tool) => ({ [RTK_PATH_ENV]: tool.binPath }),
    claudeEntry: (tool) => buildRtkHookEntry(tool.binPath),
    codexGroup: (_tool, relayPath) => codexGroup(buildHookCommand(relayPath, 'rtk')),
  },
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

export { HOOK_TOOLS, mergeCodexPreToolUse, quoteCommandPath, toForwardSlashes };
export type { HookToolId, ResolvedHookTool, HookToolDescriptor };
