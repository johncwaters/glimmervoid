import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PacksInstalled } from '../../shared/contracts/pack.ts';
import type { PackRow } from '../../shared/contracts/control/pack-messages.ts';
import { errorMessage } from '../../shared/text.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { writeTextAtomic } from '../json-file.ts';
import { checkPack, packCheckHasProblem, packReportText } from './pack-check.ts';
import { PACKS_DIR_NAME, readPackDir } from './pack-files.ts';

export const PACKS_INSTALLED_FILE_NAME = 'packs-installed.json';
const PACK_STAGING_DIR_NAME = 'pack-staging';

type PackInstallDeps = {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  packRows: () => readonly PackRow[];
  isApproved: (fingerprint: string) => boolean;
};
type PackInstallOutcome = { ok: true; name: string; dir: string; hasReplaced: boolean } | { ok: false; error: string };
type PackRemoveOutcome = { ok: true; dir: string } | { ok: false; error: string };
type FingerprintsByName = Record<string, string>;
type LedgerRead = { ok: true; fingerprintsByName: FingerprintsByName } | { ok: false; error: string };

let ledgerChanges: Promise<unknown> = Promise.resolve();

function serialized<Outcome>(change: () => Promise<Outcome>): Promise<Outcome> {
  const running = ledgerChanges.then(change);
  ledgerChanges = running.catch(() => undefined);
  return running;
}

function installedLedgerPath(homeDir: string): string {
  return path.join(homeDir, PACKS_INSTALLED_FILE_NAME);
}

async function readLedger(homeDir: string): Promise<LedgerRead> {
  const ledgerPath = installedLedgerPath(homeDir);
  const ledgerText = await fs.promises.readFile(ledgerPath, 'utf8').then(
    (text) => ({ ok: true as const, text }),
    (error: NodeJS.ErrnoException) => ({ ok: false as const, error }),
  );
  if (!ledgerText.ok && ledgerText.error.code === 'ENOENT') return { ok: true, fingerprintsByName: {} };
  if (!ledgerText.ok) return { ok: false, error: `${ledgerPath} could not be read, so installed packs are left alone: ${errorMessage(ledgerText.error)}` };
  const ledger = PacksInstalled.safeParse(parseJsonOrNull(ledgerText.text));
  if (!ledger.success) return { ok: false, error: `${ledgerPath} is not a valid install record, so installed packs are left alone; the operator can fix or delete it` };
  return { ok: true, fingerprintsByName: ledger.data.fingerprintsByName };
}

async function writeLedger(homeDir: string, fingerprintsByName: FingerprintsByName): Promise<void> {
  const sortedEntries = Object.entries(fingerprintsByName).sort(([left], [right]) => left.localeCompare(right));
  const ledger: PacksInstalled = { fingerprintsByName: Object.fromEntries(sortedEntries) };
  await writeTextAtomic(installedLedgerPath(homeDir), `${JSON.stringify(ledger, null, 2)}\n`, { mkdir: true });
}

async function isInstalledCopy(targetDir: string, recordedFingerprint: string | undefined, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (recordedFingerprint === undefined) return false;
  const read = await readPackDir(targetDir, env);
  return read.ok && read.pack.fingerprint === recordedFingerprint;
}

async function pathExists(target: string): Promise<boolean> {
  return fs.promises.lstat(target).then(() => true, () => false);
}

async function stageCopy(stagingDir: string, filesByPath: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const [relativePath, bytes] of filesByPath) {
    const destination = path.join(stagingDir, ...relativePath.split('/'));
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, bytes);
  }
}

async function placeStaged({ homeDir, stagingDir, targetDir, commit }: { homeDir: string; stagingDir: string; targetDir: string; commit: () => Promise<void> }): Promise<boolean> {
  await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
  const hasTarget = await pathExists(targetDir);
  const displacedDir = path.join(homeDir, PACK_STAGING_DIR_NAME, `displaced-${crypto.randomUUID()}`);
  if (hasTarget) await fs.promises.rename(targetDir, displacedDir);
  try {
    await fs.promises.rename(stagingDir, targetDir);
    await commit();
  } catch (error) {
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    if (hasTarget) await fs.promises.rename(displacedDir, targetDir);
    throw error;
  }
  if (hasTarget) await fs.promises.rm(displacedDir, { recursive: true, force: true });
  return hasTarget;
}

async function installNow(sourceDir: string, deps: PackInstallDeps): Promise<PackInstallOutcome> {
  const report = await checkPack(sourceDir, deps.env, deps.isApproved);
  if (packCheckHasProblem(report)) return { ok: false, error: `Not installed, because the pack has problems:\n${packReportText(report)}` };
  const read = await readPackDir(sourceDir, deps.env);
  if (!read.ok) return { ok: false, error: `Not installed: ${read.errors.join('; ')}` };
  const packName = read.pack.header.name;
  const targetDir = path.join(deps.homeDir, PACKS_DIR_NAME, packName);
  if (path.resolve(sourceDir) === targetDir) return { ok: false, error: `${sourceDir} is already the installed folder; write the pack somewhere else and install it from there` };
  const clashingRow = deps.packRows().find((row) => row.name === packName && row.dir !== targetDir);
  if (clashingRow) return { ok: false, error: `Another pack named '${packName}' is loaded from ${clashingRow.dir}; rename this pack or ask the operator to remove that one` };
  const ledger = await readLedger(deps.homeDir);
  if (!ledger.ok) return { ok: false, error: `Not installed: ${ledger.error}` };
  const isOwnCopy = await isInstalledCopy(targetDir, ledger.fingerprintsByName[packName], deps.env);
  if (await pathExists(targetDir) && !isOwnCopy) return { ok: false, error: `${targetDir} was placed or changed by hand, so install leaves it alone; rename this pack or ask the operator to remove that folder` };
  const stagingDir = path.join(deps.homeDir, PACK_STAGING_DIR_NAME, `${packName}-${crypto.randomUUID()}`);
  try {
    await stageCopy(stagingDir, read.pack.filesByPath);
    const commit = () => writeLedger(deps.homeDir, { ...ledger.fingerprintsByName, [packName]: read.pack.fingerprint });
    const hasReplaced = await placeStaged({ homeDir: deps.homeDir, stagingDir, targetDir, commit });
    return { ok: true, name: packName, dir: targetDir, hasReplaced };
  } catch (error) {
    const cleanupError = await fs.promises.rm(stagingDir, { recursive: true, force: true }).then(() => null, (rmError: unknown) => rmError);
    const leftover = cleanupError === null ? '' : `; ${stagingDir} may be left behind: ${errorMessage(cleanupError)}`;
    return { ok: false, error: `Could not install ${packName} into ${targetDir}: ${errorMessage(error)}${leftover}` };
  }
}

async function removeNow(packName: string, homeDir: string, env: NodeJS.ProcessEnv): Promise<PackRemoveOutcome> {
  const ledger = await readLedger(homeDir);
  if (!ledger.ok) return { ok: false, error: `Not removed: ${ledger.error}` };
  const targetDir = path.join(homeDir, PACKS_DIR_NAME, packName);
  const recordedFingerprint = ledger.fingerprintsByName[packName];
  const notInstalled = `'${packName}' is not a copy packs install placed, so remove leaves it alone; the operator removes a hand-placed pack by deleting its folder`;
  if (recordedFingerprint === undefined) return { ok: false, error: notInstalled };
  const remainingFingerprints = Object.fromEntries(Object.entries(ledger.fingerprintsByName).filter(([installedName]) => installedName !== packName));
  try {
    if (!await pathExists(targetDir)) {
      await writeLedger(homeDir, remainingFingerprints);
      return { ok: false, error: `${targetDir} is already gone` };
    }
    if (!await isInstalledCopy(targetDir, recordedFingerprint, env)) {
      await writeLedger(homeDir, remainingFingerprints);
      return { ok: false, error: notInstalled };
    }
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    await writeLedger(homeDir, remainingFingerprints);
    return { ok: true, dir: targetDir };
  } catch (error) {
    return { ok: false, error: `Could not remove ${targetDir}: ${errorMessage(error)}` };
  }
}

async function removeHandPlacedNow(packDir: string, homeDir: string, env: NodeJS.ProcessEnv): Promise<PackRemoveOutcome> {
  const targetDir = path.resolve(packDir);
  const folderName = path.basename(targetDir);
  if (path.dirname(targetDir) !== path.join(homeDir, PACKS_DIR_NAME)) return { ok: false, error: `${targetDir} is not a folder directly in ${path.join(homeDir, PACKS_DIR_NAME)}, so it is left alone` };
  if (!await pathExists(targetDir)) return { ok: false, error: `${targetDir} is already gone` };
  const ledger = await readLedger(homeDir);
  if (!ledger.ok) return { ok: false, error: `Not removed: ${ledger.error}` };
  const recordedFingerprint = ledger.fingerprintsByName[folderName];
  const read = recordedFingerprint === undefined ? null : await readPackDir(targetDir, env);
  if (read !== null && !read.ok) return { ok: false, error: `Glimmervoid installed ${folderName} and its folder could not be read, so it is left alone: ${read.errors.join('; ')}` };
  if (read?.ok && read.pack.fingerprint === recordedFingerprint) return { ok: false, error: `Glimmervoid installed ${folderName}; remove it from its pack source instead` };
  try {
    await fs.promises.rm(targetDir, { recursive: true, force: true });
    return { ok: true, dir: targetDir };
  } catch (error) {
    return { ok: false, error: `Could not remove ${targetDir}: ${errorMessage(error)}` };
  }
}

export async function readInstalledFingerprints(homeDir: string): Promise<Readonly<Record<string, string>> | null> {
  const ledger = await readLedger(homeDir);
  return ledger.ok ? ledger.fingerprintsByName : null;
}

export function removeHandPlacedPack(packDir: string, homeDir: string, env: NodeJS.ProcessEnv): Promise<PackRemoveOutcome> {
  return serialized(() => removeHandPlacedNow(packDir, homeDir, env));
}

export function installPack(sourceDir: string, deps: PackInstallDeps): Promise<PackInstallOutcome> {
  return serialized(() => installNow(sourceDir, deps));
}

export function removeInstalledPack(packName: string, homeDir: string, env: NodeJS.ProcessEnv): Promise<PackRemoveOutcome> {
  return serialized(() => removeNow(packName, homeDir, env));
}
