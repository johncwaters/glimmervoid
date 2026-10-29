import fs from 'node:fs';
import { resolveArgvCommandMatches } from '../session/core/spawn-command.ts';
import { execFileSync } from './child-process-safe.ts';

function realpathOrNull(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function findStableNodePath(): string {
  const runningNodeRealpath = realpathOrNull(process.execPath);
  if (runningNodeRealpath === null) return process.execPath;
  const nodesOnPath = resolveArgvCommandMatches('node', { platform: process.platform, execFile: execFileSync });
  return nodesOnPath.find((candidate) => realpathOrNull(candidate) === runningNodeRealpath) ?? process.execPath;
}

const stableNodePath = findStableNodePath();

export { stableNodePath };
