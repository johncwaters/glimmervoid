import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { glimmervoidHomeDir } from '../../server/core/config-path-core.ts';
import { writeJsonAtomic } from '../../server/json-file.ts';
import { WATCHEE_SETTINGS_FILENAME, WATCHER_HOME_ENV, WatcheeSettingsFile } from '../../shared/contracts/watchee-settings.ts';
import { errorMessage } from '../../shared/text.ts';

const OWNER_ONLY_FILE_MODE = 0o600;

function watcherHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[WATCHER_HOME_ENV] || path.join(glimmervoidHomeDir(os.homedir(), env), 'watcher');
}

async function writeWatcheeSettings(watcherHome: string, settings: WatcheeSettingsFile): Promise<void> {
  await writeJsonAtomic(path.join(watcherHome, WATCHEE_SETTINGS_FILENAME), WatcheeSettingsFile.parse(settings), { mode: OWNER_ONLY_FILE_MODE, enforceMode: true, mkdir: true });
}

async function readWatcheeSettings(watcherHome: string): Promise<{ ok: true; settings: WatcheeSettingsFile } | { ok: false; reason: string }> {
  const settingsPath = path.join(watcherHome, WATCHEE_SETTINGS_FILENAME);
  const text = await fs.readFile(settingsPath, 'utf8').catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
  if (text instanceof Error) return { ok: false, reason: `cannot read ${settingsPath}: ${errorMessage(text)}` };
  const parsed = WatcheeSettingsFile.safeParse(parseJsonOrUndefined(text));
  if (!parsed.success) return { ok: false, reason: `${settingsPath} is malformed` };
  return { ok: true, settings: parsed.data };
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readJsonFileOrUndefined(filePath: string): Promise<unknown> {
  const text = await fs.readFile(filePath, 'utf8').catch(() => null);
  return text === null ? undefined : parseJsonOrUndefined(text);
}

export { OWNER_ONLY_FILE_MODE, readJsonFileOrUndefined, readWatcheeSettings, watcherHomeDir, writeWatcheeSettings };
