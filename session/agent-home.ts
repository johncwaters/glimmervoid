import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { glimmervoidHomeDir } from "../server/core/config-path-core.ts";
import { loadFileLocks } from "../server/session-temp/session-temp-locks.ts";
import { writeTextAtomicSync } from "../server/json-file.ts";
import { errorMessage, isMissingFileError } from "../shared/text.ts";
import { AGENT_HOME_ACCOUNT_CONFIG_NAME, AGENT_HOME_CONFLICTS_NAME, AGENT_HOME_IN_USE_LOCK_NAME, AGENT_HOME_SOURCES_NAME, AGENT_HOME_PROFILES, PACK_SKILLS_MARKER_NAME, SKILLS_ENTRY_NAME, fileStampKey, resolveRealAgentHome, linkKindFor, planAgentHome } from "./core/agent-home-core.ts";
import { mergeSharedKeys } from "./core/agent-account-core.ts";
import { takeClaudeConfigLock } from "./adapters/claude-trust.ts";
import type { AgentHomeLinkKind, AgentHomePlan, AgentHomeProfile, AgentHomeStep, GeneratedAgentHomeEntry, RealAgentHomeEntry } from "./core/agent-home-core.ts";

const GENERATED_HOME_MODE = 0o700;
const GENERATED_FILE_MODE = 0o600;
const CLEAN_HOME_FOLDER_NAME = "clean";

type AgentHomeEnv = Record<string, string | undefined>;

interface AgentHomeOptions {
  env: AgentHomeEnv;
  renderBlock: (operatorText: string) => string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  generatedHome?: string;
  generatedFiles?: Readonly<Record<string, string>>;
  isClean?: boolean;
  isAccountHome?: boolean;
  packSkillDirs?: readonly string[];
}

interface ScratchAgentHomeOptions {
  env: AgentHomeEnv;
  renderBlock: (operatorText: string) => string;
  home: string;
  configSuffix: string;
  files: Readonly<Record<string, string>>;
}

function realAgentHome(profile: AgentHomeProfile, env: AgentHomeEnv = process.env, homeDir: string = os.homedir()): string {
  return resolveRealAgentHome(profile, env, homeDir, readOptionalText);
}

function generatedAgentHomePath(profile: AgentHomeProfile, env: AgentHomeEnv = process.env, homeDir: string = os.homedir(), isClean?: boolean): string {
  return path.join(glimmervoidHomeDir(homeDir, env), "agent-homes", profile.vendor, isClean ? CLEAN_HOME_FOLDER_NAME : "", profile.homeEnvSubfolder ?? "");
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

function readRealConfig(realHome: string, configName: string): { text: string | null } | { refusal: string } {
  const configPath = path.join(realHome, configName);
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
  const generatedHome = options.generatedHome ?? generatedAgentHomePath(profile, options.env, options.homeDir, options.isClean);
  try {
    return { generatedHome, realHome, plan: planFromDisk(profile, options, realHome, generatedHome) };
  } catch (error) {
    return { generatedHome, realHome, plan: { kind: "refused", reason: `${realHome} or ${generatedHome} cannot be listed: ${errorMessage(error)}` } };
  }
}

interface ConfigTexts {
  realConfigText: string | null;
  baseConfigText: string | null;
  generatedConfigText: string | null;
  accountConfigText: string | null;
}

function readConfigTexts(profile: AgentHomeProfile, realHome: string, generatedHome: string): ConfigTexts | { refusal: string } {
  if (profile.config === null) return { realConfigText: null, baseConfigText: null, generatedConfigText: null, accountConfigText: null };
  const realConfig = readRealConfig(realHome, profile.config.configName);
  if ("refusal" in realConfig) return realConfig;
  return {
    realConfigText: realConfig.text,
    baseConfigText: readOptionalText(path.join(generatedHome, profile.config.baseName)),
    generatedConfigText: readOptionalText(path.join(generatedHome, profile.config.configName)),
    accountConfigText: readOptionalText(path.join(generatedHome, AGENT_HOME_ACCOUNT_CONFIG_NAME)),
  };
}

function planFromDisk(profile: AgentHomeProfile, { renderBlock, platform = process.platform, isClean, isAccountHome, packSkillDirs = [] }: AgentHomeOptions, realHome: string, generatedHome: string): AgentHomePlan {
  const configTexts = readConfigTexts(profile, realHome, generatedHome);
  if ("refusal" in configTexts) return { kind: "refused", reason: configTexts.refusal };
  const generatedEntries = childNamesOf(generatedHome).map((name) => describeGeneratedEntry(generatedHome, realHome, name));
  const privateFolderNames = new Set(generatedEntries.filter((entry) => entry.kind === "folder").map((entry) => entry.name));
  if (packSkillDirs.length > 0) privateFolderNames.add(SKILLS_ENTRY_NAME);
  return planAgentHome({
    profile,
    realHome,
    realEntries: listRealEntries(realHome, privateFolderNames),
    generatedEntries,
    ...configTexts,
    renderBlock,
    sourceStamps: readSourceStamps(generatedHome),
    platform,
    isClean: isClean === true,
    isAccountHome: isAccountHome === true,
    packSkillDirs,
  });
}

function stepEntryPath(profile: AgentHomeProfile, generatedHome: string, step: AgentHomeStep): string {
  if (step.kind === "write-account-config") return path.join(generatedHome, AGENT_HOME_ACCOUNT_CONFIG_NAME);
  if (step.kind !== "write-config" && step.kind !== "write-base") return path.join(generatedHome, step.name);
  if (profile.config === null) throw new Error(`a ${profile.vendor} home has no config file to write`);
  return path.join(generatedHome, step.kind === "write-config" ? profile.config.configName : profile.config.baseName);
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

function createLink(entryPath: string, target: string, linkKind: AgentHomeLinkKind): void {
  if (linkKind === "hardlink") {
    fs.linkSync(target, entryPath);
    return;
  }
  fs.symlinkSync(target, entryPath, linkKind === "junction" ? "junction" : undefined);
}

function linkChild(childPath: string, target: string, platform: NodeJS.Platform): void {
  const targetStat = statOrNull(target);
  if (targetStat === null) return;
  createLink(childPath, target, linkKindFor(targetStat.isDirectory() ? "folder" : "file", platform));
}

function writePackSkillsFolder(generatedHome: string, entryPath: string, links: readonly { name: string; target: string }[]): void {
  fs.mkdirSync(entryPath, { recursive: true, mode: GENERATED_HOME_MODE });
  fs.writeFileSync(path.join(entryPath, PACK_SKILLS_MARKER_NAME), "", { mode: GENERATED_FILE_MODE });
  const targetByChildName = new Map(links.map((link) => [link.name, link.target]));
  for (const childName of childNamesOf(entryPath)) {
    if (childName === PACK_SKILLS_MARKER_NAME) continue;
    const childPath = path.join(entryPath, childName);
    const childStat = fs.lstatSync(childPath);
    const target = targetByChildName.get(childName);
    if (target !== undefined && isLinkTo(childPath, childStat, target)) {
      targetByChildName.delete(childName);
      continue;
    }
    if (childStat.isSymbolicLink()) {
      fs.unlinkSync(childPath);
      continue;
    }
    if (target !== undefined) setAside(generatedHome, childPath, `${SKILLS_ENTRY_NAME}-${childName}`);
  }
  for (const [childName, target] of targetByChildName) linkChild(path.join(entryPath, childName), target, process.platform);
}

function clearPackSkillsFolder(generatedHome: string, entryPath: string, keepsAgentWrites: boolean): void {
  for (const childName of childNamesOf(entryPath)) {
    const childPath = path.join(entryPath, childName);
    if (childName === PACK_SKILLS_MARKER_NAME || fs.lstatSync(childPath).isSymbolicLink()) {
      fs.unlinkSync(childPath);
      continue;
    }
    if (!keepsAgentWrites) setAside(generatedHome, childPath, `${SKILLS_ENTRY_NAME}-${childName}`);
  }
  if (childNamesOf(entryPath).length === 0) fs.rmdirSync(entryPath);
}

function applyStep(profile: AgentHomeProfile, generatedHome: string, step: AgentHomeStep): void {
  const entryPath = stepEntryPath(profile, generatedHome, step);
  switch (step.kind) {
    case "write-config":
    case "write-base":
    case "write-account-config":
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
    case "write-pack-skills":
      writePackSkillsFolder(generatedHome, entryPath, step.links);
      return;
    case "clear-pack-skills":
      clearPackSkillsFolder(generatedHome, entryPath, step.keepsAgentWrites);
      return;
  }
  createLink(entryPath, step.target, step.linkKind);
}

function stepFailure(profile: AgentHomeProfile, generatedHome: string, step: AgentHomeStep, error: unknown): string {
  const entryPath = stepEntryPath(profile, generatedHome, step);
  if (step.kind === "link") return `${entryPath} cannot be linked to ${step.target}: ${errorMessage(error)}`;
  if (step.kind === "promote") return `${entryPath} cannot be moved into ${step.target}: ${errorMessage(error)}`;
  return `${entryPath} cannot be written: ${errorMessage(error)}`;
}

function isLinkTo(entryPath: string, entryStat: fs.Stats, target: string): boolean {
  if (entryStat.isSymbolicLink()) return path.resolve(path.dirname(entryPath), fs.readlinkSync(entryPath)) === target;
  const targetStat = statOrNull(target);
  return targetStat !== null && isSameFile(entryStat, targetStat);
}

function isReplaceableRootEntry(entryStat: fs.Stats): boolean {
  return entryStat.isSymbolicLink() || !entryStat.isDirectory();
}

function linkHomeRootEntries(profile: AgentHomeProfile, realHome: string, generatedHome: string, platform: NodeJS.Platform): string | null {
  if (profile.homeEnvSubfolder === null) return null;
  const realRoot = path.dirname(realHome);
  const generatedRoot = path.dirname(generatedHome);
  for (const name of profile.homeRootLinkNames) {
    const target = path.join(realRoot, name);
    const entryPath = path.join(generatedRoot, name);
    const targetStat = statOrNull(target);
    const entryStat = fs.lstatSync(entryPath, { throwIfNoEntry: false }) ?? null;
    if (entryStat !== null && !isReplaceableRootEntry(entryStat)) continue;
    if (entryStat !== null && targetStat !== null && isLinkTo(entryPath, entryStat, target)) continue;
    try {
      if (entryStat !== null) fs.unlinkSync(entryPath);
      if (targetStat === null) continue;
      const linkKind = linkKindFor(targetStat.isDirectory() ? "folder" : "file", platform);
      applyStep(profile, generatedRoot, { kind: "link", name, target, linkKind });
    } catch (error) {
      return `${entryPath} cannot be linked to ${target}: ${errorMessage(error)}`;
    }
  }
  return null;
}

function operatorLauncherConfigPath(profile: AgentHomeProfile, configName: string, env: AgentHomeEnv = process.env, homeDir: string = os.homedir()): string {
  const configuredHome = env[profile.homeEnvName]?.trim() ?? "";
  if (configuredHome) return path.resolve(configuredHome, configName);
  return path.join(realAgentHome(profile, env, homeDir), configName);
}

function writeLauncherConfig(profile: AgentHomeProfile, options: AgentHomeOptions, generatedHome: string): string | null {
  if (profile.renderLauncherConfig === null || profile.config === null) return null;
  const launcherConfigPath = path.join(path.dirname(generatedHome), profile.config.configName);
  try {
    const operatorLauncherText = readOptionalText(operatorLauncherConfigPath(profile, profile.config.configName, options.env, options.homeDir)) ?? "";
    writeTextAtomicSync(launcherConfigPath, profile.renderLauncherConfig(operatorLauncherText), { mode: GENERATED_FILE_MODE, enforceMode: true });
    return null;
  } catch (error) {
    return `${launcherConfigPath} cannot be written: ${errorMessage(error)}`;
  }
}

function realFileStamps(realHome: string): Record<string, string> {
  const stamps: Record<string, string> = {};
  for (const entry of listRealEntries(realHome, new Set())) {
    if (entry.fileStamp !== null) stamps[fileStampKey(entry.name)] = entry.fileStamp;
  }
  return stamps;
}

function prepareAgentHome(profile: AgentHomeProfile, options: AgentHomeOptions): { home: string } | { refusal: string } {
  const generatedHome = options.generatedHome ?? generatedAgentHomePath(profile, options.env, options.homeDir, options.isClean);
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
      applyStep(profile, generatedHome, step);
    } catch (error) {
      if (step.kind !== "adopt") return { refusal: stepFailure(profile, generatedHome, step, error) };
      keptPrivateNames.add(step.name);
    }
  }
  for (const [name, text] of Object.entries(options.generatedFiles ?? {})) {
    try {
      writeTextAtomicSync(path.join(generatedHome, name), text, { mode: GENERATED_FILE_MODE, enforceMode: true });
    } catch (error) {
      return { refusal: `${path.join(generatedHome, name)} cannot be written: ${errorMessage(error)}` };
    }
  }
  const realHome = realAgentHome(profile, options.env, options.homeDir);
  const rootLinkRefusal = linkHomeRootEntries(profile, realHome, generatedHome, options.platform ?? process.platform);
  if (rootLinkRefusal !== null) return { refusal: rootLinkRefusal };
  const launcherConfigRefusal = writeLauncherConfig(profile, options, generatedHome);
  if (launcherConfigRefusal !== null) return { refusal: launcherConfigRefusal };
  try {
    writeTextAtomicSync(path.join(generatedHome, AGENT_HOME_SOURCES_NAME), `${JSON.stringify(realFileStamps(realHome), null, 2)}\n`, { mode: GENERATED_FILE_MODE });
  } catch (error) {
    return { refusal: `${path.join(generatedHome, AGENT_HOME_SOURCES_NAME)} cannot be written: ${errorMessage(error)}` };
  }
  return { home: generatedHome };
}

function readJsonObjectFile(filePath: string): Record<string, unknown> | null {
  const text = readOptionalText(filePath);
  if (text === null || text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed));
  } catch {
    return null;
  }
}

function pickReadCandidate(candidatePaths: readonly string[]): string {
  return candidatePaths.find((candidatePath) => statOrNull(candidatePath) !== null) ?? candidatePaths[candidatePaths.length - 1];
}

async function syncMixedAccountFiles(profile: AgentHomeProfile, accountFolder: string, env: AgentHomeEnv, homeDir: string): Promise<string | null> {
  for (const mixedFile of profile.account?.mixedFiles ?? []) {
    const realFilePath = pickReadCandidate(mixedFile.candidatePaths(env, homeDir));
    const accountFilePath = pickReadCandidate(mixedFile.candidatePaths({ ...env, [profile.homeEnvName]: accountFolder }, homeDir));
    const lockPath = await takeClaudeConfigLock(accountFilePath).catch(() => null);
    if (lockPath === null) return `${accountFilePath} is locked by another process, so the shared keys of ${realFilePath} cannot be copied`;
    try {
      const accountFile = readJsonObjectFile(accountFilePath);
      const realFile = readJsonObjectFile(realFilePath);
      if (accountFile === null || realFile === null) continue;
      const merged = mergeSharedKeys(accountFile, realFile, mixedFile.sharedKeys, mixedFile.seededKeys);
      if (merged !== null) writeTextAtomicSync(accountFilePath, `${JSON.stringify(merged, null, 2)}\n`, { mode: GENERATED_FILE_MODE, enforceMode: true });
    } catch (error) {
      return `${accountFilePath} cannot take the shared keys of ${realFilePath}: ${errorMessage(error)}`;
    } finally {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }
  return null;
}

function isSameFolder(firstPath: string, secondPath: string): boolean {
  const firstStat = statOrNull(firstPath);
  const secondStat = statOrNull(secondPath);
  if (firstStat === null || secondStat === null) return path.resolve(firstPath) === path.resolve(secondPath);
  return firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino;
}

function accountHomeOf(profile: AgentHomeProfile, accountFolder: string): string {
  return path.join(accountFolder, profile.homeEnvSubfolder ?? "");
}

function accountFolderRefusal(profile: AgentHomeProfile, env: AgentHomeEnv, accountFolder: string, homeDir: string): string | null {
  if (!profile.account) return `${profile.vendor} has no account support`;
  if (!path.isAbsolute(accountFolder)) return `the account folder ${accountFolder} is not an absolute path`;
  if (isSameFolder(realAgentHome(profile, env, homeDir), accountHomeOf(profile, accountFolder))) return `the account folder ${accountFolder} is the machine's own ${profile.vendor} home`;
  if (statOrNull(accountFolder)?.isDirectory() !== true) return `the account folder ${accountFolder} is missing; sign in to that account again`;
  return agentHomeLinkRefusal(accountFolder);
}

async function prepareAccountHome(profile: AgentHomeProfile, { env, accountFolder, homeDir = os.homedir() }: { env: AgentHomeEnv; accountFolder: string; homeDir?: string }): Promise<{ home: string } | { refusal: string }> {
  const refusal = accountFolderRefusal(profile, env, accountFolder, homeDir);
  if (refusal !== null) return { refusal };
  const prepared = prepareAgentHome(profile, { env, homeDir, renderBlock: () => (profile.config?.kind === "json" ? "{}" : ""), generatedHome: accountHomeOf(profile, accountFolder), isAccountHome: true });
  if ("refusal" in prepared) return prepared;
  releaseUnheldAccountHomeSecrets(profile, accountFolder);
  const syncRefusal = await syncMixedAccountFiles(profile, accountFolder, env, homeDir);
  if (syncRefusal !== null) return { refusal: syncRefusal };
  return prepared;
}

function releaseUnheldAccountHomeSecrets(profile: AgentHomeProfile, accountFolder: string): void {
  if (profile.config === null) return;
  releaseUnheldAgentHomeSecrets(accountHomeOf(profile, accountFolder));
}

function holdPreparedAccountHome(profile: AgentHomeProfile, env: AgentHomeEnv, renderBlock: (operatorText: string) => string, renderGeneratedFiles: () => Readonly<Record<string, string>>, accountFolder: string, packSkillDirs: readonly string[]): { home: string } | { refusal: string } {
  const refusal = accountFolderRefusal(profile, env, accountFolder, os.homedir());
  if (refusal !== null) return { refusal };
  const accountHome = accountHomeOf(profile, accountFolder);
  holdAgentHome(accountHome);
  const prepared = prepareAgentHome(profile, { env, renderBlock, generatedFiles: renderGeneratedFiles(), generatedHome: accountHome, isAccountHome: true, packSkillDirs });
  if ("refusal" in prepared) releaseAgentHome(accountHome);
  return prepared;
}

function holdPreparedAgentHome(profile: AgentHomeProfile, env: AgentHomeEnv, renderBlock: (operatorText: string) => string, renderGeneratedFiles: () => Readonly<Record<string, string>> = () => ({}), isClean?: boolean, accountFolder: string | null = null, packSkillDirs: readonly string[] = []): { home: string } | { refusal: string } {
  if (isClean && !profile.cleanOmits) return { refusal: `a clean ${profile.vendor} home is not supported` };
  if (isClean && accountFolder !== null) return { refusal: `a clean ${profile.vendor} home cannot run under an added account` };
  if (accountFolder !== null) return holdPreparedAccountHome(profile, env, renderBlock, renderGeneratedFiles, accountFolder, packSkillDirs);
  const generatedHome = generatedAgentHomePath(profile, env, os.homedir(), isClean);
  if (path.resolve(realAgentHome(profile, env)) === path.resolve(generatedHome)) return { refusal: `${profile.homeEnvName} already points at the generated home ${generatedHome}` };
  const linkRefusal = agentHomeLinkRefusal(generatedHome);
  if (linkRefusal !== null) return { refusal: linkRefusal };
  holdAgentHome(generatedHome);
  const prepared = prepareAgentHome(profile, { env, renderBlock, generatedFiles: renderGeneratedFiles(), isClean, packSkillDirs });
  if ("refusal" in prepared) releaseAgentHome(generatedHome);
  return prepared;
}

function prepareScratchAgentHome(profile: AgentHomeProfile, { env, renderBlock, home, configSuffix, files }: ScratchAgentHomeOptions): { home: string } | { refusal: string } {
  if (profile.config?.kind !== "toml") return { refusal: `a ${profile.vendor} lane home is not supported` };
  const prepared = prepareAgentHome(profile, { env, renderBlock, generatedHome: home });
  if ("refusal" in prepared) return prepared;
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.rmSync(path.join(home, name), { force: true });
      fs.writeFileSync(path.join(home, name), text, { mode: GENERATED_FILE_MODE });
    }
    fs.appendFileSync(path.join(home, profile.config.configName), configSuffix);
  } catch (error) {
    return { refusal: `${home} cannot take the lane files: ${errorMessage(error)}` };
  }
  return prepared;
}

function agentHomeNotes(profile: AgentHomeProfile, generatedHome: string, plan: Extract<AgentHomePlan, { kind: "ready" }>): string[] {
  const notes: string[] = [];
  if (plan.hasStaleBlockInRealConfig) notes.push(`the real ${profile.config?.configName ?? "config"} still holds an old Glimmervoid hooks block, which ${profile.vendor} sessions here ignore and you can delete`);
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

const SECRET_CONFIG_NAMES: readonly string[] = [...new Set(AGENT_HOME_PROFILES.flatMap(({ config }) => config ? [config.configName, config.baseName] : []))];

function releaseAgentHomeSecrets(generatedHome: string): void {
  for (const name of SECRET_CONFIG_NAMES) {
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

function releaseEveryUnheldAgentHomeSecrets(env: AgentHomeEnv = process.env, accountHomes: readonly { profile: AgentHomeProfile; folder: string }[] = []): void {
  for (const { profile, folder } of accountHomes) releaseUnheldAccountHomeSecrets(profile, folder);
  for (const profile of AGENT_HOME_PROFILES) {
    releaseUnheldAgentHomeSecrets(generatedAgentHomePath(profile, env));
    if (profile.cleanOmits) releaseUnheldAgentHomeSecrets(generatedAgentHomePath(profile, env, undefined, true));
  }
}

export { describeAgentHome, generatedAgentHomePath, holdAgentHome, holdPreparedAgentHome, prepareAccountHome, prepareAgentHome, prepareScratchAgentHome, readOptionalText, realAgentHome, releaseAgentHome, releaseEveryUnheldAgentHomeSecrets, releaseUnheldAgentHomeSecrets };

