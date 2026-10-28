import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { glimmervoidHomeDir } from "../server/core/config-path-core.ts";
import { writeTextAtomicSync } from "../server/json-file.ts";
import { errorMessage, isMissingFileError } from "../shared/text.ts";
import { KIMI_CONFIG_NAME, KIMI_SOURCES_NAME, planKimiHome } from "./core/kimi-hooks-block-core.ts";
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

function realEntryKind(entryPath: string): RealKimiEntry["kind"] | null {
  try {
    return fs.statSync(entryPath).isDirectory() ? "folder" : "file";
  } catch {
    return null;
  }
}

function listRealEntries(realHome: string): RealKimiEntry[] {
  const entries: RealKimiEntry[] = [];
  for (const dirent of listFolder(realHome)) {
    const kind = realEntryKind(path.join(realHome, dirent.name));
    if (kind) entries.push({ name: dirent.name, kind });
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
  if (entryStat.isSymbolicLink()) return { name, kind: "link", linkTarget: path.resolve(generatedHome, fs.readlinkSync(entryPath)) };
  if (entryStat.isDirectory()) return { name, kind: "folder", linkTarget: null };
  const hardLinkedTo = hardLinkTarget(entryStat, realHome, name);
  if (hardLinkedTo) return { name, kind: "link", linkTarget: hardLinkedTo };
  return { name, kind: "file", linkTarget: null };
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
  const generatedNames = listFolder(generatedHome).map((dirent) => dirent.name);
  return planKimiHome({
    realHome,
    realEntries: listRealEntries(realHome),
    generatedEntries: generatedNames.map((name) => describeGeneratedEntry(generatedHome, realHome, name)),
    realConfigText: realConfig.text,
    generatedConfigText: readOptionalText(path.join(generatedHome, KIMI_CONFIG_NAME)),
    hooksBlock,
    sourceStamps: readSourceStamps(generatedHome),
    platform,
  });
}

function stepEntryPath(generatedHome: string, step: KimiHomeStep): string {
  return path.join(generatedHome, step.kind === "write-config" ? KIMI_CONFIG_NAME : step.name);
}

function applyStep(generatedHome: string, step: KimiHomeStep): void {
  const entryPath = stepEntryPath(generatedHome, step);
  if (step.kind === "write-config") {
    writeTextAtomicSync(entryPath, step.text, { mode: GENERATED_FILE_MODE, enforceMode: true });
    return;
  }
  if (step.kind === "unlink") {
    fs.unlinkSync(entryPath);
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
  return `${entryPath} cannot be written: ${errorMessage(error)}`;
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
  for (const step of plan.steps) {
    try {
      applyStep(generatedHome, step);
    } catch (error) {
      return { refusal: stepFailure(generatedHome, step, error) };
    }
  }
  try {
    writeTextAtomicSync(path.join(generatedHome, KIMI_SOURCES_NAME), `${JSON.stringify(plan.sourceStamps, null, 2)}\n`, { mode: GENERATED_FILE_MODE });
  } catch (error) {
    return { refusal: `${path.join(generatedHome, KIMI_SOURCES_NAME)} cannot be written: ${errorMessage(error)}` };
  }
  return { home: generatedHome };
}

export { generatedKimiHomePath, inspectKimiHome, prepareKimiHome, realKimiHome };
export type { KimiHomeOptions, KimiHomeReading };
