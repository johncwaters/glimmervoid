import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { packAgentFolderName, packAgentLaunchOf, packNameOfFolder, planPackAgentFiles } from '../../session/core/pack-session-core.ts';
import type { PackAgentContribution, PackAgentFile, PackAgentLaunch } from '../../session/core/pack-session-core.ts';

const PARTIAL_FOLDER_MARKER = '.partial-';
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;

type PackSessionFiles = {
  sync: (contributions: readonly PackAgentContribution[]) => Promise<{ warnings: string[] }>;
  launch: () => PackAgentLaunch | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(target: string): Promise<boolean> {
  return fs.promises.lstat(target).then(() => true, () => false);
}

function scratchPathBeside(folder: string): string {
  return `${folder}${PARTIAL_FOLDER_MARKER}${crypto.randomBytes(6).toString('hex')}`;
}

async function replaceFolderAtomically(folder: string, files: readonly PackAgentFile[]): Promise<void> {
  const partialFolder = scratchPathBeside(folder);
  const replacedFolder = scratchPathBeside(folder);
  try {
    await fs.promises.mkdir(partialFolder, { recursive: true, mode: FOLDER_MODE });
    for (const file of files) {
      const filePath = path.join(partialFolder, ...file.relativePath.split('/'));
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: FOLDER_MODE });
      await fs.promises.writeFile(filePath, file.bytes, { mode: FILE_MODE });
    }
    if (await pathExists(folder)) await fs.promises.rename(folder, replacedFolder);
    await fs.promises.rename(partialFolder, folder);
  } finally {
    await fs.promises.rm(partialFolder, { recursive: true, force: true });
    await fs.promises.rm(replacedFolder, { recursive: true, force: true });
  }
}

function isKeptFolder(folderName: string, currentFolderNames: ReadonlySet<string>, approvedPackNames: ReadonlySet<string>, isFirstSync: boolean): boolean {
  if (currentFolderNames.has(folderName)) return true;
  if (folderName.includes(PARTIAL_FOLDER_MARKER)) return false;
  if (isFirstSync) return false;
  const packName = packNameOfFolder(folderName);
  return packName !== null && approvedPackNames.has(packName);
}

function createPackSessionFiles({ root }: { root: string }): PackSessionFiles {
  let currentLaunch: PackAgentLaunch | null = null;
  let hasSynced = false;
  let pendingSync: Promise<unknown> = Promise.resolve();
  const foldersWrittenThisRun = new Set<string>();

  async function ensurePackFolder(folder: string, files: readonly PackAgentFile[]): Promise<string | null> {
    if (foldersWrittenThisRun.has(folder) && await pathExists(folder)) return null;
    const writeError = await replaceFolderAtomically(folder, files).then(() => null, (error: unknown) => errorMessage(error));
    if (writeError === null) foldersWrittenThisRun.add(folder);
    return writeError;
  }

  async function writeContributions(contributions: readonly PackAgentContribution[]): Promise<{ written: PackAgentContribution[]; warnings: string[] }> {
    const written: PackAgentContribution[] = [];
    const warnings: string[] = [];
    for (const contribution of contributions) {
      const planned = planPackAgentFiles(contribution);
      if ('refusal' in planned) {
        warnings.push(`The pack ${contribution.packName} gives sessions nothing: ${planned.refusal}`);
        continue;
      }
      const folder = path.join(root, packAgentFolderName(contribution.packName, contribution.fingerprint));
      const writeError = await ensurePackFolder(folder, planned.files);
      if (writeError !== null) {
        warnings.push(`The pack ${contribution.packName} gives sessions nothing: ${folder} cannot be written: ${writeError}`);
        continue;
      }
      warnings.push(...planned.warnings);
      written.push(contribution);
    }
    return { written, warnings };
  }

  async function removeStaleFolders(approved: readonly PackAgentContribution[], written: readonly PackAgentContribution[], isFirstSync: boolean): Promise<string[]> {
    const currentFolderNames = new Set(written.map((contribution) => packAgentFolderName(contribution.packName, contribution.fingerprint)));
    const approvedPackNames = new Set(approved.map((contribution) => contribution.packName));
    const folderNames = await fs.promises.readdir(root).catch(() => []);
    const warnings: string[] = [];
    for (const folderName of folderNames) {
      if (isKeptFolder(folderName, currentFolderNames, approvedPackNames, isFirstSync)) continue;
      await fs.promises.rm(path.join(root, folderName), { recursive: true, force: true }).catch((error: unknown) => {
        warnings.push(`${path.join(root, folderName)} cannot be removed: ${errorMessage(error)}`);
      });
    }
    return warnings;
  }

  async function syncNow(contributions: readonly PackAgentContribution[]): Promise<{ warnings: string[] }> {
    const isFirstSync = !hasSynced;
    hasSynced = true;
    const rootError = await fs.promises.mkdir(root, { recursive: true, mode: FOLDER_MODE }).then(() => null, (error: unknown) => errorMessage(error));
    if (rootError !== null) {
      currentLaunch = null;
      return { warnings: [`Pack skills and context reach no session: ${root} cannot be created: ${rootError}`] };
    }
    const { written, warnings } = await writeContributions(contributions);
    currentLaunch = packAgentLaunchOf(root, written);
    const removalWarnings = await removeStaleFolders(contributions, written, isFirstSync);
    return { warnings: [...warnings, ...removalWarnings] };
  }

  function sync(contributions: readonly PackAgentContribution[]): Promise<{ warnings: string[] }> {
    const queued = pendingSync.then(() => syncNow(contributions));
    pendingSync = queued.catch(() => undefined);
    return queued;
  }

  return { sync, launch: () => currentLaunch };
}

export type { PackSessionFiles };
export { createPackSessionFiles };
