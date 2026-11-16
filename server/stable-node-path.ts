import fs from 'node:fs';
import path from 'node:path';
import { resolveArgvCommandMatches } from '../session/core/spawn-command.ts';
import { execFileSync } from './child-process-safe.ts';

function realpathOrNull(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function findStableLauncherPath(commandName: string): string {
  const runningExecutableRealpath = realpathOrNull(process.execPath);
  if (runningExecutableRealpath === null) return process.execPath;
  const commandsOnPath = resolveArgvCommandMatches(commandName, { platform: process.platform, execFile: execFileSync });
  return commandsOnPath.find((candidate) => realpathOrNull(candidate) === runningExecutableRealpath) ?? process.execPath;
}

const stableLauncherPathByCommand = new Map<string, string>();

function stableLauncherPathFor(commandName: string): string {
  const knownPath = stableLauncherPathByCommand.get(commandName);
  if (knownPath !== undefined) return knownPath;
  const foundPath = findStableLauncherPath(commandName);
  stableLauncherPathByCommand.set(commandName, foundPath);
  return foundPath;
}

async function firstCommandOnPath(program: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, program);
    const isExecutableFile = await fs.promises.access(candidate, fs.constants.X_OK)
      .then(async () => (await fs.promises.stat(candidate)).isFile())
      .catch(() => false);
    if (isExecutableFile) return candidate;
  }
  return null;
}

export { firstCommandOnPath, stableLauncherPathFor };
