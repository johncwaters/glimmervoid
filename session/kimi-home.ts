import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { glimmervoidHomeDir } from "../server/core/config-path-core.ts";
import { loadFileLocks } from "../server/guardrails/session-temp-locks.ts";
import { writeTextAtomicSync } from "../server/json-file.ts";
import { errorMessage, isMissingFileError } from "../shared/text.ts";
import { KIMI_BASE_NAME, KIMI_CONFIG_NAME, KIMI_CONFLICTS_NAME, KIMI_IN_USE_LOCK_NAME, KIMI_SOURCES_NAME, fileStampKey, planKimiHome } from "./core/kimi-hooks-block-core.ts";
import type { GeneratedKimiEntry, KimiHomePlan, KimiHomeStep, RealKimiEntry } from "./core/kimi-hooks-block-core.ts";

const GENERATED_HOME_MODE = 0o700;
const GENERATED_FILE_MODE = 0o600;

type KimiEnv = Record<string, string | undefined>;

interface KimiHomeOptions {
  env: KimiEnv;
  hooksBlock: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

function realKimiHome(env: KimiEnv = process.env, homeDir: string = os.homedir()): string {
  const configuredHome = typeof env.KIMI_CODE_HOME === "string" ? env.KIMI_CODE_HOME.trim() : "";
  if (configuredHome) return path.resolve(configuredHome);
  return path.join(homeDir, ".kimi-code");
}

function generatedKimiHomePath(env: KimiEnv = process.env, homeDir: string = os.homedir()): string {
  return path.join(glimmervoidHomeDir(homeDir, env), "agent-homes", "kimi");
}

function listFolder(folder: string): fs.Dirent[] {
  try {
    return fs.readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

function statOrNull(entryPath: string): fs.Stats | null {
  try {
    return fs.statSync(entryPath);
  } catch {
    return null;
  }
}

function fileStampOf(entryStat: fs.Stats): string {
  return `${entryStat.size}:${entryStat.mtimeMs}`;
}

function childNamesOf(folder: string): string[] {
  return listFolder(folder).map((dirent) => dirent.name);
}

function listRealEntries(realHome: string, privateFolderNames: ReadonlySet<string>): RealKimiEntry[] {
  const entries: RealKimiEntry[] = [];
  for (const dirent of listFolder(realHome)) {
    const entryPath = path.join(realHome, dirent.name);
    const entryStat = statOrNull(entryPath);
    if (!entryStat) continue;
    if (entryStat.isDirectory()) {
      const childNames = privateFolderNames.has(dirent.name) ? childNamesOf(entryPath) : [];
      entries.push({ name: dirent.name, kind: "folder", fileStamp: null, childNames });
      continue;
    }
    entries.push({ name: dirent.name, kind: "file", fileStamp: fileStampOf(entryStat), childNames: [] });
  }
  return entries;
}

function isSameFile(first: fs.Stats, second: fs.Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function hardLinkTarget(entryStat: fs.Stats, realHome: string, name: string): string | null {
  if (entryStat.nlink < 2) return null;
  const realPath = path.join(realHome, name);
  try {
    return isSameFile(entryStat, fs.statSync(realPath)) ? realPath : null;
  } catch {
    return null;
  }
}

function describeGeneratedEntry(generatedHome: string, realHome: string, name: string): GeneratedKimiEntry {
  const entryPath = path.join(generatedHome, name);
  const entryStat = fs.lstatSync(entryPath);
  if (entryStat.isSymbolicLink()) return { name, kind: "link", linkTarget: path.resolve(generatedHome, fs.readlinkSync(entryPath)), childNames: [] };
  if (entryStat.isDirectory()) return { name, kind: "folder", linkTarget: null, childNames: childNamesOf(entryPath) };
  const hardLinkedTo = hardLinkTarget(entryStat, realHome, name);
  if (hardLinkedTo) return { name, kind: "link", linkTarget: hardLinkedTo, childNames: [] };
  return { name, kind: "file", linkTarget: null, childNames: [] };
}

function readOptionalText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function readRealConfig(realHome: string): { text: string | null } | { refusal: string } {
  const configPath = path.join(realHome, KIMI_CONFIG_NAME);
  try {
    return { text: fs.readFileSync(configPath, "utf8") };
  } catch (error) {
    if (isMissingFileError(error)) return { text: null };
    return { refusal: `the real ${configPath} cannot be read: ${errorMessage(error)}` };
  }
}

function readSourceStamps(generatedHome: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(generatedHome, KIMI_SOURCES_NAME), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

interface KimiHomeReading {
  generatedHome: string;
  realHome: string;
  plan: KimiHomePlan;
}

function inspectKimiHome(options: KimiHomeOptions): KimiHomeReading {
  const realHome = realKimiHome(options.env, options.homeDir);
  const generatedHome = generatedKimiHomePath(options.env, options.homeDir);
  try {
    return { generatedHome, realHome, plan: planFromDisk(options, realHome, generatedHome) };
  } catch (error) {
    return { generatedHome, realHome, plan: { kind: "refused", reason: `${realHome} or ${generatedHome} cannot be listed: ${errorMessage(error)}` } };
  }
}

function planFromDisk({ hooksBlock, platform = process.platform }: KimiHomeOptions, realHome: string, generatedHome: string): KimiHomePlan {
  const realConfig = readRealConfig(realHome);
  if ("refusal" in realConfig) return { kind: "refused", reason: realConfig.refusal };
  const generatedEntries = childNamesOf(generatedHome).map((name) => describeGeneratedEntry(generatedHome, realHome, name));
  const privateFolderNames = new Set(generatedEntries.filter((entry) => entry.kind === "folder").map((entry) => entry.name));
  return planKimiHome({
    realHome,
    realEntries: listRealEntries(realHome, privateFolderNames),
    generatedEntries,
    realConfigText: realConfig.text,
    baseConfigText: readOptionalText(path.join(generatedHome, KIMI_BASE_NAME)),
    generatedConfigText: readOptionalText(path.join(generatedHome, KIMI_CONFIG_NAME)),
    hooksBlock,
    sourceStamps: readSourceStamps(generatedHome),
    platform,
  });
}

function stepEntryPath(generatedHome: string, step: KimiHomeStep): string {
  if (step.kind === "write-config") return path.join(generatedHome, KIMI_CONFIG_NAME);
  if (step.kind === "write-base") return path.join(generatedHome, KIMI_BASE_NAME);
  return path.join(generatedHome, step.name);
}

function promoteIntoRealHome(entryPath: string, target: string): void {
  const resolvedTarget = fs.realpathSync(target);
  const stagedPath = `${resolvedTarget}.glimmervoid-${process.pid}`;
  try {
    fs.copyFileSync(entryPath, stagedPath);
    fs.chmodSync(stagedPath, fs.statSync(resolvedTarget).mode & 0o777);
    fs.renameSync(stagedPath, resolvedTarget);
  } catch (error) {
    fs.rmSync(stagedPath, { force: true });
    throw error;
  }
  fs.unlinkSync(entryPath);
}

function setAside(generatedHome: string, entryPath: string, name: string): void {
  const conflictsFolder = path.join(generatedHome, KIMI_CONFLICTS_NAME);
  fs.mkdirSync(conflictsFolder, { recursive: true, mode: GENERATED_HOME_MODE });
  let copyNumber = 1;
  while (fs.existsSync(path.join(conflictsFolder, `${name}.${copyNumber}`))) copyNumber += 1;
  fs.renameSync(entryPath, path.join(conflictsFolder, `${name}.${copyNumber}`));
}

function moveAcrossVolumes(source: string, destination: string): void {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    fs.rmSync(source, { recursive: true });
  }
}

function adoptFolder(entryPath: string, target: string, childNames: readonly string[]): void {
  for (const childName of childNames) moveAcrossVolumes(path.join(entryPath, childName), path.join(target, childName));
  fs.rmdirSync(entryPath);
}

function applyStep(generatedHome: string, step: KimiHomeStep): void {
  const entryPath = stepEntryPath(generatedHome, step);
  switch (step.kind) {
    case "write-config":
    case "write-base":
      writeTextAtomicSync(entryPath, step.text, { mode: GENERATED_FILE_MODE, enforceMode: true });
      return;
    case "unlink":
      fs.unlinkSync(entryPath);
      return;
    case "promote":
      promoteIntoRealHome(entryPath, step.target);
      return;
    case "set-aside":
      setAside(generatedHome, entryPath, step.name);
      return;
    case "adopt":
      adoptFolder(entryPath, step.target, step.childNames);
      return;
  }
  if (step.linkKind === "hardlink") {
    fs.linkSync(step.target, entryPath);
    return;
  }
  fs.symlinkSync(step.target, entryPath, step.linkKind === "junction" ? "junction" : undefined);
}

function stepFailure(generatedHome: string, step: KimiHomeStep, error: unknown): string {
  const entryPath = stepEntryPath(generatedHome, step);
  if (step.kind === "link") return `${entryPath} cannot be linked to ${step.target}: ${errorMessage(error)}`;
  if (step.kind === "promote") return `${entryPath} cannot be moved into ${step.target}: ${errorMessage(error)}`;
  return `${entryPath} cannot be written: ${errorMessage(error)}`;
}

function realFileStamps(realHome: string): Record<string, string> {
  const stamps: Record<string, string> = {};
  for (const entry of listRealEntries(realHome, new Set())) {
    if (entry.fileStamp !== null) stamps[fileStampKey(entry.name)] = entry.fileStamp;
  }
  return stamps;
}

function prepareKimiHome(options: KimiHomeOptions): { home: string } | { refusal: string } {
  const generatedHome = generatedKimiHomePath(options.env, options.homeDir);
  try {
    fs.mkdirSync(generatedHome, { recursive: true, mode: GENERATED_HOME_MODE });
    fs.chmodSync(generatedHome, GENERATED_HOME_MODE);
  } catch (error) {
    return { refusal: `${generatedHome} cannot be created: ${errorMessage(error)}` };
  }
  const { plan } = inspectKimiHome(options);
  if (plan.kind === "refused") return { refusal: plan.reason };
  const keptPrivateNames = new Set<string>();
  for (const step of plan.steps) {
    if ("name" in step && keptPrivateNames.has(step.name)) continue;
    try {
      applyStep(generatedHome, step);
    } catch (error) {
      if (step.kind !== "adopt") return { refusal: stepFailure(generatedHome, step, error) };
      keptPrivateNames.add(step.name);
    }
  }
  const realHome = realKimiHome(options.env, options.homeDir);
  try {
    writeTextAtomicSync(path.join(generatedHome, KIMI_SOURCES_NAME), `${JSON.stringify(realFileStamps(realHome), null, 2)}\n`, { mode: GENERATED_FILE_MODE });
  } catch (error) {
    return { refusal: `${path.join(generatedHome, KIMI_SOURCES_NAME)} cannot be written: ${errorMessage(error)}` };
  }
  return { home: generatedHome };
}

const liveSessionCountByHome = new Map<string, number>();
const inUseLockDescriptorByHome = new Map<string, number>();

function inUseLockPath(generatedHome: string): string {
  return path.join(generatedHome, KIMI_IN_USE_LOCK_NAME);
}

function takeSharedInUseLock(generatedHome: string): void {
  const locks = loadFileLocks();
  if (locks === null) return;
  fs.mkdirSync(generatedHome, { recursive: true, mode: GENERATED_HOME_MODE });
  const lockDescriptor = fs.openSync(inUseLockPath(generatedHome), "a+", GENERATED_FILE_MODE);
  locks.waitForLockSync(lockDescriptor, { shared: true });
  inUseLockDescriptorByHome.set(generatedHome, lockDescriptor);
}

function dropSharedInUseLock(generatedHome: string): void {
  const lockDescriptor = inUseLockDescriptorByHome.get(generatedHome);
  if (lockDescriptor === undefined) return;
  inUseLockDescriptorByHome.delete(generatedHome);
  loadFileLocks()?.unlock(lockDescriptor);
  fs.closeSync(lockDescriptor);
}

function openInUseLock(generatedHome: string): number | null {
  try {
    return fs.openSync(inUseLockPath(generatedHome), "a+", GENERATED_FILE_MODE);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function releaseSecretsUnlessHeldElsewhere(generatedHome: string, { whenLocksMissing }: { whenLocksMissing: "release" | "keep" }): void {
  const locks = loadFileLocks();
  if (locks === null) {
    if (whenLocksMissing === "release") releaseKimiHomeSecrets(generatedHome);
    return;
  }
  const lockDescriptor = openInUseLock(generatedHome);
  if (lockDescriptor === null) return;
  try {
    if (!locks.tryLock(lockDescriptor)) return;
    releaseKimiHomeSecrets(generatedHome);
    locks.unlock(lockDescriptor);
  } finally {
    fs.closeSync(lockDescriptor);
  }
}

function holdKimiHome(generatedHome: string): void {
  const liveSessionCount = (liveSessionCountByHome.get(generatedHome) ?? 0) + 1;
  liveSessionCountByHome.set(generatedHome, liveSessionCount);
  if (liveSessionCount === 1) takeSharedInUseLock(generatedHome);
}

function releaseKimiHomeSecrets(generatedHome: string): void {
  for (const name of [KIMI_CONFIG_NAME, KIMI_BASE_NAME]) {
    try {
      fs.rmSync(path.join(generatedHome, name), { force: true });
    } catch (error) {
      console.warn(`[kimi-home] ${path.join(generatedHome, name)} could not be deleted: ${errorMessage(error)}`);
    }
  }
}

function releaseKimiHome(generatedHome: string): void {
  const liveSessionCount = (liveSessionCountByHome.get(generatedHome) ?? 0) - 1;
  if (liveSessionCount > 0) {
    liveSessionCountByHome.set(generatedHome, liveSessionCount);
    return;
  }
  liveSessionCountByHome.delete(generatedHome);
  dropSharedInUseLock(generatedHome);
  releaseSecretsUnlessHeldElsewhere(generatedHome, { whenLocksMissing: "release" });
}

function releaseUnheldKimiHomeSecrets(generatedHome: string): void {
  releaseSecretsUnlessHeldElsewhere(generatedHome, { whenLocksMissing: "keep" });
}

export { generatedKimiHomePath, holdKimiHome, inspectKimiHome, prepareKimiHome, realKimiHome, releaseKimiHome, releaseKimiHomeSecrets, releaseUnheldKimiHomeSecrets };
export type { KimiHomeOptions, KimiHomeReading };
