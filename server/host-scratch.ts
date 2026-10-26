import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { glimmervoidHomeDir } from './config-store.ts';
import { recordSweptPath } from './removal-journal.ts';
import { decideOrphanedScratchFolders, HOST_SCRATCH_PREFIXES, type HostScratchPrefix } from './core/host-scratch-core.ts';

const folderNamesCreatedByThisProcess = new Set<string>();

export function hostScratchRoot(): string {
  return path.join(glimmervoidHomeDir(), 'scratch');
}

export async function makeHostScratchDirectory(prefix: HostScratchPrefix): Promise<string> {
  await mkdir(hostScratchRoot(), { recursive: true, mode: 0o700 });
  const scratchDirectory = await mkdtemp(path.join(await realpath(hostScratchRoot()), prefix));
  folderNamesCreatedByThisProcess.add(path.basename(scratchDirectory));
  return scratchDirectory;
}

async function listScratchFolderNames(scratchRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(scratchRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function sweepOrphanedHostScratch(): Promise<void> {
  const scratchRoot = hostScratchRoot();
  const orphanedFolderNames = decideOrphanedScratchFolders(await listScratchFolderNames(scratchRoot), HOST_SCRATCH_PREFIXES, folderNamesCreatedByThisProcess);
  for (const folderName of orphanedFolderNames) {
    const folderPath = path.join(scratchRoot, folderName);
    if (!(await recordSweptPath({ cause: 'host-scratch', kind: 'folder', path: folderPath, checksPassed: ['not-made-by-this-process'] }))) continue;
    try {
      await rm(folderPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Could not remove leftover scratch folder ${folderName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
