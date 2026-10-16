import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { SANE_YOLO_FILES } from '../session/core/sane-yolo.ts';
import { glimmervoidHomeDir } from './core/config-path-core.ts';
import { dataHome } from './ingest/core/ingest-shell-core.ts';
import { getRtkPath } from './rtk-resolver.ts';
import { resolvePackageBin } from './runtime-paths.ts';
import { writeTextAtomicSync } from './json-file.ts';
import { isMissingFileError } from '../shared/text.ts';

const writtenHomes = new Set<string>();
const warnedTools = new Set<string>();
const ensuredDataDirs = new Set<string>();
const RTK_DATA_FOLDER = 'rtk';

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
      if (!isMissingFileError(error, { includeNotDir: false })) throw error;
    }
    if (previous !== serialized) writeTextAtomicSync(filePath, serialized, { mode: 0o600 });
  }
  writtenHomes.add(homeDir);
}

function rtkDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string | null {
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', RTK_DATA_FOLDER);
  if (platform !== 'linux') return null;
  const dataHomeDir = dataHome(env, homeDir);
  return path.isAbsolute(dataHomeDir) ? path.join(dataHomeDir, RTK_DATA_FOLDER) : null;
}

function ensureDataDir(dataDir: string | null): string | null {
  if (dataDir === null || ensuredDataDirs.has(dataDir)) return dataDir;
  fs.mkdirSync(dataDir, { recursive: true });
  ensuredDataDirs.add(dataDir);
  return dataDir;
}

function rtkHookTool(binPath: string, warn: (message: string) => void): ResolvedHookTool {
  try {
    const dataDir = ensureDataDir(rtkDataDir());
    return dataDir === null ? { id: 'rtk', binPath } : { id: 'rtk', binPath, dataDir };
  } catch (error) {
    warnOnce('rtkDataDir', `[rtk] The rtk data folder could not be created: ${String(error)}. Guarded sessions will run rtk without savings tracking.`, warn);
    return { id: 'rtk', binPath };
  }
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
    if (rtkPath) hookTools.push(rtkHookTool(rtkPath, warn));
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

function resolveRequiredSaneYoloHookTools(
  config: { rtk?: boolean },
  { resolve = resolveHookTools }: { resolve?: typeof resolveHookTools } = {},
): ResolvedHookTool[] | null {
  const hookTools = resolve({ rtk: config.rtk, saneYolo: true }, { skipPermissions: true });
  return hookTools.some((tool) => tool.id === 'saneYolo') ? hookTools : null;
}

export { resolveHookTools, resolveRequiredSaneYoloHookTools, rtkDataDir, saneYoloHomeDir, writeSaneYoloPolicy };
