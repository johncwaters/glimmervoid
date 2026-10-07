import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { SANE_YOLO_FILES } from '../session/core/sane-yolo.ts';
import { glimmervoidHomeDir } from './core/config-path-core.ts';
import { getRtkPath } from './rtk-resolver.ts';
import { resolvePackageBin } from './runtime-paths.ts';

const writtenHomes = new Set<string>();
const warnedTools = new Set<string>();

function saneYoloHomeDir(): string {
  return path.join(glimmervoidHomeDir(os.homedir(), process.env), 'sane-yolo');
}

function writeSaneYoloPolicy(homeDir: string): void {
  if (writtenHomes.has(homeDir)) return;
  for (const [relativePath, contents] of Object.entries(SANE_YOLO_FILES)) {
    const filePath = path.join(homeDir, relativePath);
    const serialized = `${JSON.stringify(contents, null, 2)}\n`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    let previous: string | null = null;
    try {
      previous = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (previous !== serialized) fs.writeFileSync(filePath, serialized, { mode: 0o600 });
  }
  writtenHomes.add(homeDir);
}

function warnOnce(toolId: string, message: string, warn: (message: string) => void): void {
  if (warnedTools.has(toolId)) return;
  warnedTools.add(toolId);
  warn(message);
}

function resolveHookTools(
  config: { rtk?: boolean; saneYolo?: boolean },
  { skipPermissions, warn = console.warn }: { skipPermissions: boolean; warn?: (message: string) => void },
): ResolvedHookTool[] {
  const hookTools: ResolvedHookTool[] = [];
  if (config.rtk) {
    const rtkPath = getRtkPath();
    if (rtkPath) hookTools.push({ id: 'rtk', binPath: rtkPath });
    if (!rtkPath) warnOnce('rtk', '[rtk] config.rtk is true, but no rtk binary was found. Sessions will spawn without rtk hooks.', warn);
  }
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

export { resolveHookTools, saneYoloHomeDir, writeSaneYoloPolicy };
