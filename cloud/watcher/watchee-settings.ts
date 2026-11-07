import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { glimmervoidHomeDir } from '../../server/core/config-path-core.ts';
import { writeJsonAtomic } from '../../server/json-file.ts';
import { WATCHEE_SETTINGS_FILENAME, WATCHER_HOME_ENV, WatcheeSettingsReply } from '../../shared/contracts/watchee-settings.ts';
import { errorMessage } from '../../shared/text.ts';
import type { WatcheeFileStore } from '../watchees/watchee.ts';

const OWNER_ONLY_FILE_MODE = 0o600;

function watcherHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[WATCHER_HOME_ENV] || path.join(glimmervoidHomeDir(os.homedir(), env), 'watcher');
}

async function writeWatcheeSettings(watcherHome: string, reply: WatcheeSettingsReply): Promise<void> {
  await writeJsonAtomic(path.join(watcherHome, WATCHEE_SETTINGS_FILENAME), WatcheeSettingsReply.parse(reply), { mode: OWNER_ONLY_FILE_MODE, enforceMode: true, mkdir: true });
}

async function readWatcheeSettings(watcherHome: string): Promise<{ ok: true; reply: WatcheeSettingsReply } | { ok: false; reason: string }> {
  const settingsPath = path.join(watcherHome, WATCHEE_SETTINGS_FILENAME);
  const text = await fs.readFile(settingsPath, 'utf8').catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
  if (text instanceof Error) return { ok: false, reason: `cannot read ${settingsPath}: ${errorMessage(text)}` };
  const parsed = WatcheeSettingsReply.safeParse(parseJsonOrUndefined(text));
  if (!parsed.success) return { ok: false, reason: `${settingsPath} is malformed` };
  return { ok: true, reply: parsed.data };
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

function createWatcheeFileStore(watcherHome: string): WatcheeFileStore {
  return {
    read: (fileName) => readJsonFileOrUndefined(path.join(watcherHome, fileName)),
    write: (fileName, value) => writeJsonAtomic(path.join(watcherHome, fileName), value, { mode: OWNER_ONLY_FILE_MODE, enforceMode: true, mkdir: true }),
  };
}

export { createWatcheeFileStore, OWNER_ONLY_FILE_MODE, readJsonFileOrUndefined, readWatcheeSettings, watcherHomeDir, writeWatcheeSettings };
