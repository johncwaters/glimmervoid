import { chmod, copyFile, lstat, readdir, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RetiredGuardrailsOwner } from '../../shared/contracts/retired-guardrails-owner.ts';
import { isPathInside } from '../../shared/paths.ts';
import { errorCode, errorMessage, isMissingFileError } from '../../shared/text.ts';
import { loadJsonStateFile } from '../json-file.ts';
import { recordSweptPath } from '../removal-journal.ts';

const RETIRED_POLICY_FOLDER = 'guardrails-policies';
const RETIRED_LAUNCH_HOME_FOLDER = 'guardrails-homes';
const RETIRED_GUARDRAILS_FOLDERS: readonly string[] = Object.freeze([RETIRED_LAUNCH_HOME_FOLDER, RETIRED_POLICY_FOLDER]);
const OWNER_FILE_SUFFIX = '.owner.json';
const LAUNCH_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOGIN_FILE_MODE = 0o600;
const OWN_PID_NAMESPACE_LINK = '/proc/self/ns/pid';

type RetiredLaunchOutcome = { status: 'recovered' } | { status: 'kept'; reason: string };

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function isOwnerProcessGone(owner: RetiredGuardrailsOwner, ownPidNamespace: string | null): boolean {
  return owner.ownerHost === os.hostname() && owner.ownerPidNamespace === ownPidNamespace && !isProcessAlive(owner.ownerPid);
}

async function readOwnerFile(ownerPath: string): Promise<RetiredGuardrailsOwner | null> {
  const outcome = await loadJsonStateFile({ filePath: ownerPath, quarantine: false, parse: (raw) => RetiredGuardrailsOwner.safeParse(raw).data ?? null });
  return outcome.status === 'loaded' ? outcome.value : null;
}

async function removeEmptyPlaceholders(placeholderPaths: readonly string[]): Promise<void> {
  for (const placeholderPath of placeholderPaths) {
    const placeholderStats = await lstat(placeholderPath).catch(() => null);
    if (placeholderStats?.isFile() && placeholderStats.size === 0) await rm(placeholderPath, { force: true });
  }
}

async function isNewerThanTarget(linkModifiedMs: number, targetPath: string): Promise<boolean> {
  const targetStats = await stat(targetPath).catch(() => null);
  if (targetStats === null) return true;
  return linkModifiedMs > targetStats.mtimeMs;
}

async function keepRefreshedLogins(owner: RetiredGuardrailsOwner, launchHomeDir: string, launchId: string): Promise<void> {
  const loginsInLaunchHome = owner.logins.filter((login) => isPathInside(launchHomeDir, login.linkPath, { allowEqual: false }));
  for (const { linkPath, targetPath } of loginsInLaunchHome) {
    const linkStats = await lstat(linkPath).catch(() => null);
    if (!linkStats?.isFile()) continue;
    if (!(await isNewerThanTarget(linkStats.mtimeMs, targetPath))) continue;
    const stagedPath = `${targetPath}.${launchId}`;
    await copyFile(linkPath, stagedPath);
    await chmod(stagedPath, LOGIN_FILE_MODE);
    await rename(stagedPath, targetPath);
  }
}

async function recoverRetiredLaunch(ownerPath: string, launchHomeDir: string, launchId: string, ownPidNamespace: string | null): Promise<RetiredLaunchOutcome> {
  const owner = await readOwnerFile(ownerPath);
  if (owner === null) return { status: 'recovered' };
  if (!isOwnerProcessGone(owner, ownPidNamespace)) return { status: 'kept', reason: `launch ${launchId} may still belong to Glimmervoid process ${owner.ownerPid} on ${owner.ownerHost}` };
  await removeEmptyPlaceholders(owner.placeholderPaths);
  await keepRefreshedLogins(owner, launchHomeDir, launchId);
  return { status: 'recovered' };
}

async function recoverRetiredLaunches(glimmervoidHome: string): Promise<RetiredLaunchOutcome> {
  const policyFolder = path.join(glimmervoidHome, RETIRED_POLICY_FOLDER);
  const entryNames = await readdir(policyFolder).catch((error: unknown) => {
    if (isMissingFileError(error)) return [];
    throw error;
  });
  const realGlimmervoidHome = await realpath(glimmervoidHome);
  const ownPidNamespace = await readlink(OWN_PID_NAMESPACE_LINK).catch(() => null);
  for (const entryName of entryNames) {
    if (!entryName.endsWith(OWNER_FILE_SUFFIX)) continue;
    const launchId = entryName.slice(0, -OWNER_FILE_SUFFIX.length);
    if (!LAUNCH_ID_SHAPE.test(launchId)) continue;
    const launchHomeDir = path.join(realGlimmervoidHome, RETIRED_LAUNCH_HOME_FOLDER, launchId);
    const outcome = await recoverRetiredLaunch(path.join(policyFolder, entryName), launchHomeDir, launchId, ownPidNamespace);
    if (outcome.status === 'kept') return outcome;
  }
  return { status: 'recovered' };
}

async function deleteRetiredGuardrailsFolders(glimmervoidHome: string, log: Pick<Console, 'warn'> = console): Promise<void> {
  const recovery = await recoverRetiredLaunches(glimmervoidHome).catch((error: unknown): RetiredLaunchOutcome => ({ status: 'kept', reason: errorMessage(error) }));
  if (recovery.status === 'kept') {
    log.warn(`[session-temp] kept the retired guardrails folders until a later start: ${recovery.reason}`);
    return;
  }
  for (const folderName of RETIRED_GUARDRAILS_FOLDERS) {
    const folderPath = path.join(glimmervoidHome, folderName);
    const isPresent = await stat(folderPath).then(() => true, () => false);
    if (!isPresent) continue;
    if (!(await recordSweptPath({ cause: 'guardrails-leftovers', kind: 'folder', path: folderPath, checksPassed: ['owner-process-gone', 'logins-kept'], log }))) continue;
    await rm(folderPath, { recursive: true, force: true }).catch((error: unknown) => {
      log.warn(`[session-temp] could not delete the retired ${folderName} folder: ${errorMessage(error)}`);
    });
  }
}

export { deleteRetiredGuardrailsFolders };
