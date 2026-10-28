import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { saneYoloFiles } from '../session/core/sane-yolo.ts';
import { glimmervoidHomeDir } from './core/config-path-core.ts';
import { GUARDRAILS_TEMP_FOLDER } from './guardrails/core/guardrails-policy-core.ts';
import { resolvePackageBin } from './runtime-paths.ts';
import { writeTextAtomicSync } from './json-file.ts';
import { isMissingFileError } from '../shared/text.ts';

const writtenHomes = new Set<string>();
const warnedTools = new Set<string>();

function currentGlimmervoidHome(): string {
  return glimmervoidHomeDir(os.homedir(), process.env);
}

function saneYoloHomeDir(): string {
  return path.join(currentGlimmervoidHome(), 'sane-yolo');
}

function writeSaneYoloPolicy(homeDir: string, glimmervoidHome = currentGlimmervoidHome()): void {
  if (writtenHomes.has(homeDir)) return;
  for (const [relativePath, contents] of Object.entries(saneYoloFiles(path.join(glimmervoidHome, GUARDRAILS_TEMP_FOLDER)))) {
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
  writtenHomes.add(homeDir);
}

function warnOnce(toolId: string, message: string, warn: (message: string) => void): void {
  if (warnedTools.has(toolId)) return;
  warnedTools.add(toolId);
  warn(message);
}

function resolveHookTools(
  config: { saneYolo?: boolean },
  { skipPermissions, warn = console.warn }: { skipPermissions: boolean; warn?: (message: string) => void },
): ResolvedHookTool[] {
  const hookTools: ResolvedHookTool[] = [];
  if (config.saneYolo === false || !skipPermissions) return hookTools;
  const binPath = resolvePackageBin('cc-safety-net', 'cc-safety-net');
  if (!binPath) {
    warnOnce('saneYolo', '[sane-yolo] cc-safety-net was not found. Sessions will spawn without Sane YOLO hooks.', warn);
    return hookTools;
  }
  try {
    writeSaneYoloPolicy(saneYoloHomeDir());
    hookTools.push({ id: 'saneYolo', binPath });
  } catch (error) {
    warnOnce('saneYolo', `[sane-yolo] Policy could not be written: ${String(error)}. Sessions will spawn without Sane YOLO hooks.`, warn);
  }
  return hookTools;
}

function resolveRequiredSaneYoloHookTools(
  { resolve = resolveHookTools }: { resolve?: typeof resolveHookTools } = {},
): ResolvedHookTool[] | null {
  const hookTools = resolve({ saneYolo: true }, { skipPermissions: true });
  return hookTools.some((tool) => tool.id === 'saneYolo') ? hookTools : null;
}

export { resolveHookTools, resolveRequiredSaneYoloHookTools, saneYoloHomeDir };
