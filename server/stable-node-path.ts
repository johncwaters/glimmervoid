import fs from 'node:fs';
import { resolveArgvCommandMatches, resolveArgvCommandMatchesAsync } from '../session/core/spawn-command.ts';
import { execFileAsync, execFileSync } from './child-process-safe.ts';

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

async function firstCommandOnPath(commandName: string): Promise<string | null> {
  const [firstMatch = null] = await resolveArgvCommandMatchesAsync(commandName, {
    platform: process.platform,
    execFileAsync: async (file, args, options) => String((await execFileAsync(file, [...args], options)).stdout),
  });
  return firstMatch;
}

export { firstCommandOnPath, stableLauncherPathFor };
