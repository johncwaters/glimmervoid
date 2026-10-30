import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { saneYoloFiles } from '../session/core/sane-yolo.ts';
import { glimmervoidHomeDir } from './core/config-path-core.ts';
import { SESSION_TEMP_FOLDER } from './session-temp/session-temp.ts';
import { resolvePackageBin } from './runtime-paths.ts';
import { writeTextAtomicSync } from './json-file.ts';
import { isMissingFileError } from '../shared/text.ts';

const writtenPolicyByHome = new Map<string, string>();
const warnedTools = new Set<string>();

function currentGlimmervoidHome(): string {
  return glimmervoidHomeDir(os.homedir(), process.env);
}

function saneYoloHomeDir(): string {
  return path.join(currentGlimmervoidHome(), 'sane-yolo');
}

function writeSaneYoloPolicy(homeDir: string, unreadablePaths: readonly string[], glimmervoidHome = currentGlimmervoidHome()): void {
  const policyFiles = saneYoloFiles(path.join(glimmervoidHome, SESSION_TEMP_FOLDER), unreadablePaths);
  const policyKey = JSON.stringify(policyFiles);
  if (writtenPolicyByHome.get(homeDir) === policyKey) return;
  for (const [relativePath, contents] of Object.entries(policyFiles)) {
    const filePath = path.join(homeDir, relativePath);
    const serialized = `${JSON.stringify(contents, null, 2)}\n`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    let previous: string | null = null;
    try {
      previous = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (!isMissingFileError(error, { includeNotDir: false })) throw error;
    }
    if (previous !== serialized) writeTextAtomicSync(filePath, serialized, { mode: 0o600 });
  }
  writtenPolicyByHome.set(homeDir, policyKey);
}

function warnOnce(toolId: string, message: string, warn: (message: string) => void): void {
  if (warnedTools.has(toolId)) return;
  warnedTools.add(toolId);
  warn(message);
}

type HookToolConfig = { saneYolo?: boolean; saneYoloUnreadablePaths?: readonly string[] };

function resolveHookTools(
  config: HookToolConfig,
  { warn = console.warn }: { warn?: (message: string) => void } = {},
): ResolvedHookTool[] {
  const hookTools: ResolvedHookTool[] = [];
  if (config.saneYolo === false) return hookTools;
  const binPath = resolvePackageBin('cc-safety-net', 'cc-safety-net');
  if (!binPath) {
    warnOnce('saneYolo', '[sane-yolo] cc-safety-net was not found. Sessions will spawn without Sane YOLO hooks.', warn);
    return hookTools;
  }
  try {
    writeSaneYoloPolicy(saneYoloHomeDir(), config.saneYoloUnreadablePaths ?? []);
    hookTools.push({ id: 'saneYolo', binPath });
  } catch (error) {
    warnOnce('saneYolo', `[sane-yolo] Policy could not be written: ${String(error)}. Sessions will spawn without Sane YOLO hooks.`, warn);
  }
  return hookTools;
}

function resolveRequiredSaneYoloHookTools(
  unreadablePaths: readonly string[],
  { resolve = resolveHookTools }: { resolve?: typeof resolveHookTools } = {},
): ResolvedHookTool[] | null {
  const hookTools = resolve({ saneYolo: true, saneYoloUnreadablePaths: unreadablePaths });
  return hookTools.some((tool) => tool.id === 'saneYolo') ? hookTools : null;
}

export type { HookToolConfig };
export { resolveHookTools, resolveRequiredSaneYoloHookTools, saneYoloHomeDir };
