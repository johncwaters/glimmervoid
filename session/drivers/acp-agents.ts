import fs from 'node:fs';
import { execFileSync } from '../../server/child-process-safe.ts';
import { resolveAgentCommand } from '../core/spawn-command.ts';
import type { PathLookupExecFile } from '../core/spawn-command.ts';
import {
  BUILT_IN_ACP_AGENTS,
  buildAcpAgentTable,
  formatAcpAgentDoctorValue,
  resolveAcpAgentLaunch,
} from '../core/acp-agents-core.ts';
import type { AcpAgentEntry, AcpAgentLaunchResult, AcpAgentTableResult } from '../core/acp-agents-core.ts';

interface AcpCommandProbeOptions {
  platform?: NodeJS.Platform;
  execFile?: PathLookupExecFile;
  pathExists?: (candidate: string) => boolean;
}

interface AcpAgentResolvability {
  readonly id: string;
  readonly label: string;
  readonly path: string | null;
  readonly resolvable: boolean;
  readonly doctorValue: string;
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform === 'win32') return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function describeAcpAgentResolvability(
  entry: AcpAgentEntry,
  options: AcpCommandProbeOptions = {},
): AcpAgentResolvability {
  const { platform = process.platform, execFile = execFileSync, pathExists = (candidate) => isExecutableFile(candidate, platform) } = options;
  const resolved = resolveAgentCommand({
    name: entry.command,
    platform,
    execFile,
    pathExists,
  });
  return {
    id: entry.id,
    label: entry.label,
    path: resolved.path,
    resolvable: resolved.path !== null,
    doctorValue: formatAcpAgentDoctorValue(entry, resolved.path),
  };
}

export {
  BUILT_IN_ACP_AGENTS,
  buildAcpAgentTable,
  describeAcpAgentResolvability,
  resolveAcpAgentLaunch,
};
export type { AcpAgentEntry, AcpAgentLaunchResult, AcpAgentResolvability, AcpAgentTableResult, AcpCommandProbeOptions };
