import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { glimmervoidHomeDir } from "../server/core/config-path-core.ts";
import { loadFileLocks } from "../server/guardrails/session-temp-locks.ts";
import { writeTextAtomicSync } from "../server/json-file.ts";
import { errorMessage, isMissingFileError } from "../shared/text.ts";
import { AGENT_HOME_BASE_NAME, AGENT_HOME_CONFIG_NAME, AGENT_HOME_CONFLICTS_NAME, AGENT_HOME_IN_USE_LOCK_NAME, AGENT_HOME_SOURCES_NAME, fileStampKey, planAgentHome } from "./core/agent-home-core.ts";
import type { AgentHomePlan, AgentHomeProfile, AgentHomeStep, GeneratedAgentHomeEntry, RealAgentHomeEntry } from "./core/agent-home-core.ts";

const GENERATED_HOME_MODE = 0o700;
const GENERATED_FILE_MODE = 0o600;

type AgentHomeEnv = Record<string, string | undefined>;

interface AgentHomeOptions {
  env: AgentHomeEnv;
  renderBlock: (operatorText: string) => string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  generatedHome?: string;
}

interface ScratchAgentHomeOptions {
  env: AgentHomeEnv;
  renderBlock: (operatorText: string) => string;
  home: string;
  configSuffix: string;
  files: Readonly<Record<string, string>>;
}

function realAgentHome(profile: AgentHomeProfile, env: AgentHomeEnv = process.env, homeDir: string = os.homedir()): string {
  const configuredHome = env[profile.homeEnvName]?.trim() ?? "";
  if (configuredHome) return path.resolve(configuredHome);
  return path.join(homeDir, profile.defaultHomeFolderName);
}

function generatedAgentHomePath(profile: AgentHomeProfile, env: AgentHomeEnv = process.env, homeDir: string = os.homedir()): string {
  return path.join(glimmervoidHomeDir(homeDir, env), "agent-homes", profile.vendor);
}

function agentHomeLinkRefusal(generatedHome: string): string | null {
  for (const folder of [path.dirname(generatedHome), generatedHome]) {
    let folderStat: fs.Stats;
    try {
      folderStat = fs.lstatSync(folder);
    } catch (error) {
      if (isMissingFileError(error)) continue;
      return `${folder} cannot be read: ${errorMessage(error)}`;
    }
    if (!folderStat.isDirectory()) return `${folder} is not a plain folder, so Glimmervoid will not build an agent home through it`;
  }
  return null;
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

function listRealEntries(realHome: string, privateFolderNames: ReadonlySet<string>): RealAgentHomeEntry[] {
  const entries: RealAgentHomeEntry[] = [];
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

function describeGeneratedEntry(generatedHome: string, realHome: string, name: string): GeneratedAgentHomeEntry {
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
  const configPath = path.join(realHome, AGENT_HOME_CONFIG_NAME);
  try {
    return { text: fs.readFileSync(configPath, "utf8") };
  } catch (error) {
    if (isMissingFileError(error)) return { text: null };
    return { refusal: `the real ${configPath} cannot be read: ${errorMessage(error)}` };
  }
}

function readSourceStamps(generatedHome: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(generatedHome, AGENT_HOME_SOURCES_NAME), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

interface AgentHomeReading {
  generatedHome: string;
  realHome: string;
  plan: AgentHomePlan;
}

function inspectAgentHome(profile: AgentHomeProfile, options: AgentHomeOptions): AgentHomeReading {
  const realHome = realAgentHome(profile, options.env, options.homeDir);
  const generatedHome = options.generatedHome ?? generatedAgentHomePath(profile, options.env, options.homeDir);
  try {
    return { generatedHome, realHome, plan: planFromDisk(profile, options, realHome, generatedHome) };
  } catch (error) {
    return { generatedHome, realHome, plan: { kind: "refused", reason: `${realHome} or ${generatedHome} cannot be listed: ${errorMessage(error)}` } };
  }
}

function planFromDisk(profile: AgentHomeProfile, { renderBlock, platform = process.platform }: AgentHomeOptions, realHome: string, generatedHome: string): AgentHomePlan {
  const realConfig = readRealConfig(realHome);
  if ("refusal" in realConfig) return { kind: "refused", reason: realConfig.refusal };
  const generatedEntries = childNamesOf(generatedHome).map((name) => describeGeneratedEntry(generatedHome, realHome, name));
  const privateFolderNames = new Set(generatedEntries.filter((entry) => entry.kind === "folder").map((entry) => entry.name));
  return planAgentHome({
    profile,
    realHome,
    realEntries: listRealEntries(realHome, privateFolderNames),
    generatedEntries,
    realConfigText: realConfig.text,
    baseConfigText: readOptionalText(path.join(generatedHome, AGENT_HOME_BASE_NAME)),
    generatedConfigText: readOptionalText(path.join(generatedHome, AGENT_HOME_CONFIG_NAME)),
    renderBlock,
    sourceStamps: readSourceStamps(generatedHome),
    platform,
  });
}

function stepEntryPath(generatedHome: string, step: AgentHomeStep): string {
  if (step.kind === "write-config") return path.join(generatedHome, AGENT_HOME_CONFIG_NAME);
  if (step.kind === "write-base") return path.join(generatedHome, AGENT_HOME_BASE_NAME);
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
  const conflictsFolder = path.join(generatedHome, AGENT_HOME_CONFLICTS_NAME);
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

function applyStep(generatedHome: string, step: AgentHomeStep): void {
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

function stepFailure(generatedHome: string, step: AgentHomeStep, error: unknown): string {
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

function prepareAgentHome(profile: AgentHomeProfile, options: AgentHomeOptions): { home: string } | { refusal: string } {
  const generatedHome = options.generatedHome ?? generatedAgentHomePath(profile, options.env, options.homeDir);
  try {
    fs.mkdirSync(generatedHome, { recursive: true, mode: GENERATED_HOME_MODE });
    fs.chmodSync(generatedHome, GENERATED_HOME_MODE);
  } catch (error) {
    return { refusal: `${generatedHome} cannot be created: ${errorMessage(error)}` };
  }
  const { plan } = inspectAgentHome(profile, options);
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
  const realHome = realAgentHome(profile, options.env, options.homeDir);
  try {
    writeTextAtomicSync(path.join(generatedHome, AGENT_HOME_SOURCES_NAME), `${JSON.stringify(realFileStamps(realHome), null, 2)}\n`, { mode: GENERATED_FILE_MODE });
  } catch (error) {
    return { refusal: `${path.join(generatedHome, AGENT_HOME_SOURCES_NAME)} cannot be written: ${errorMessage(error)}` };
  }
  return { home: generatedHome };
}

function holdPreparedAgentHome(profile: AgentHomeProfile, env: AgentHomeEnv, renderBlock: (operatorText: string) => string): { home: string } | { refusal: string } {
  const generatedHome = generatedAgentHomePath(profile, env);
  if (path.resolve(realAgentHome(profile, env)) === path.resolve(generatedHome)) return { refusal: `${profile.homeEnvName} already points at the generated home ${generatedHome}` };
  const linkRefusal = agentHomeLinkRefusal(generatedHome);
  if (linkRefusal !== null) return { refusal: linkRefusal };
  holdAgentHome(generatedHome);
  const prepared = prepareAgentHome(profile, { env, renderBlock });
  if ("refusal" in prepared) releaseAgentHome(generatedHome);
  return prepared;
}

function prepareScratchAgentHome(profile: AgentHomeProfile, { env, renderBlock, home, configSuffix, files }: ScratchAgentHomeOptions): { home: string } | { refusal: string } {
  const prepared = prepareAgentHome(profile, { env, renderBlock, generatedHome: home });
  if ("refusal" in prepared) return prepared;
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.rmSync(path.join(home, name), { force: true });
      fs.writeFileSync(path.join(home, name), text, { mode: GENERATED_FILE_MODE });
    }
    fs.appendFileSync(path.join(home, AGENT_HOME_CONFIG_NAME), configSuffix);
  } catch (error) {
    return { refusal: `${home} cannot take the lane files: ${errorMessage(error)}` };
  }
  return prepared;
}

function agentHomeNotes(profile: AgentHomeProfile, generatedHome: string, plan: Extract<AgentHomePlan, { kind: "ready" }>): string[] {
  const notes: string[] = [];
  if (plan.hasStaleBlockInRealConfig) notes.push(`the real config.toml still holds an old Glimmervoid hooks block, which ${profile.vendor} sessions here ignore and you can delete`);
  if (plan.privateNames.length > 0) notes.push(`kept only in the generated home: ${plan.privateNames.join(", ")}`);
  const conflictNames = childNamesOf(path.join(generatedHome, AGENT_HOME_CONFLICTS_NAME));
  if (conflictNames.length > 0) notes.push(`${conflictNames.length} ${profile.vendor} copies set aside after a conflict in ${path.join(generatedHome, AGENT_HOME_CONFLICTS_NAME)}`);
  return notes;
}

function describeAgentHome(profile: AgentHomeProfile, hooksBlock: string | null, env: AgentHomeEnv = process.env): string {
  if (hooksBlock === null) return `refused: the hook relay path cannot be written into a ${profile.vendor} hooks block`;
  const { generatedHome, realHome, plan } = inspectAgentHome(profile, { env, renderBlock: () => hooksBlock });
  if (plan.kind === "refused") return `refused: ${plan.reason}`;
  return [`ready: ${generatedHome} (real ${realHome})`, ...agentHomeNotes(profile, generatedHome, plan)].join("; ");
}

const liveSessionCountByHome = new Map<string, number>();
const inUseLockDescriptorByHome = new Map<string, number>();

function inUseLockPath(generatedHome: string): string {
  return path.join(generatedHome, AGENT_HOME_IN_USE_LOCK_NAME);
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
    if (whenLocksMissing === "release") releaseAgentHomeSecrets(generatedHome);
    return;
  }
  const lockDescriptor = openInUseLock(generatedHome);
  if (lockDescriptor === null) return;
  try {
    if (!locks.tryLock(lockDescriptor)) return;
    releaseAgentHomeSecrets(generatedHome);
    locks.unlock(lockDescriptor);
  } finally {
    fs.closeSync(lockDescriptor);
  }
}

function holdAgentHome(generatedHome: string): void {
  const liveSessionCount = (liveSessionCountByHome.get(generatedHome) ?? 0) + 1;
  liveSessionCountByHome.set(generatedHome, liveSessionCount);
  if (liveSessionCount === 1) takeSharedInUseLock(generatedHome);
}

function releaseAgentHomeSecrets(generatedHome: string): void {
  for (const name of [AGENT_HOME_CONFIG_NAME, AGENT_HOME_BASE_NAME]) {
    try {
      fs.rmSync(path.join(generatedHome, name), { force: true });
    } catch (error) {
      console.warn(`[agent-home] ${path.join(generatedHome, name)} could not be deleted: ${errorMessage(error)}`);
    }
  }
}

function releaseAgentHome(generatedHome: string): void {
  const liveSessionCount = (liveSessionCountByHome.get(generatedHome) ?? 0) - 1;
  if (liveSessionCount > 0) {
    liveSessionCountByHome.set(generatedHome, liveSessionCount);
    return;
  }
  liveSessionCountByHome.delete(generatedHome);
  dropSharedInUseLock(generatedHome);
  releaseSecretsUnlessHeldElsewhere(generatedHome, { whenLocksMissing: "release" });
}

function releaseUnheldAgentHomeSecrets(generatedHome: string): void {
  releaseSecretsUnlessHeldElsewhere(generatedHome, { whenLocksMissing: "keep" });
}

export { agentHomeLinkRefusal, describeAgentHome, generatedAgentHomePath, holdAgentHome, holdPreparedAgentHome, prepareAgentHome, prepareScratchAgentHome, realAgentHome, releaseAgentHome, releaseUnheldAgentHomeSecrets };

