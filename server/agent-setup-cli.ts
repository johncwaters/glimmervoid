import fs from "node:fs";
import path from "node:path";

import grok from "../session/adapters/grok.ts";
import kimi from "../session/adapters/kimi.ts";
import { renderGrokHooksFile, classifyGrokHooksFile } from "../session/core/grok-hooks-file-core.ts";
import { classifyKimiConfig, spliceKimiHooksBlock } from "../session/core/kimi-hooks-block-core.ts";
import { errorMessage, isMissingFileError } from "../shared/text.ts";
import { writeTextAtomicSync } from "./json-file.ts";
import type { SyncFileSystem } from "./json-file.ts";

const USAGE = "Usage: glimmervoid agent setup <grok|kimi>";

type SetupFileSystem = Pick<
  typeof fs,
  "readFileSync" | "lstatSync" | "mkdirSync" | "chmodSync" | "writeFileSync" | "renameSync" | "rmSync" | "existsSync"
>;
type DirectoryFileSystem = Pick<typeof fs, "lstatSync" | "mkdirSync" | "chmodSync">;

type AtomicWriteFileSystem = SyncFileSystem;
type ReadTextFile = (filePath: string, encoding: "utf8") => string;

interface AgentSetupInspection {
  filePath: string;
  classification: string;
  reason?: string;
  saneYoloReady?: boolean;
}

function setupInputs(env: NodeJS.ProcessEnv = process.env) {
  return {
    filePath: grok.hooksFilePath(env),
    relayPath: grok.RELAY_PATH,
    hookToolRelayPath: grok.HOOK_TOOL_RELAY_PATH,
    events: grok.HOOK_EVENTS,
    managedEventSets: grok.MANAGED_HOOK_EVENT_SETS,
  };
}

function inspectGrokAgentSetup({ env = process.env, readFileSync = fs.readFileSync }: {
  env?: NodeJS.ProcessEnv;
  readFileSync?: ReadTextFile;
} = {}): AgentSetupInspection {
  const inputs = setupInputs(env);
  let contents: string | null = null;
  try {
    contents = readFileSync(inputs.filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error, { includeNotDir: false })) return { filePath: inputs.filePath, classification: "absent" };
    return { filePath: inputs.filePath, classification: "unreadable", reason: errorMessage(error) };
  }
  return {
    filePath: inputs.filePath,
    classification: classifyGrokHooksFile(contents, inputs),
    saneYoloReady: contents === renderGrokHooksFile(inputs),
  };
}

function assertRealDirectory(directory: string, fileSystem: DirectoryFileSystem, requireOwnership = true): void {
  const directoryStat = fileSystem.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`refusing to write agent hooks: ${directory} is not a real directory`);
  }
  if (requireOwnership && typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) {
    throw new Error(`refusing to write agent hooks: ${directory} is owned by another account`);
  }
}

function ensureWritableHooksDirectory(directory: string, fileSystem: DirectoryFileSystem): void {
  const resolvedDirectory = path.resolve(directory);
  const trustedParent = path.dirname(path.dirname(resolvedDirectory));
  assertRealDirectory(trustedParent, fileSystem, false);
  const relativeParts = path.relative(trustedParent, resolvedDirectory).split(path.sep).filter(Boolean);
  let currentDirectory = trustedParent;
  for (const part of relativeParts) {
    currentDirectory = path.join(currentDirectory, part);
    try {
      assertRealDirectory(currentDirectory, fileSystem);
      continue;
    } catch (directoryError) {
      if (!isMissingFileError(directoryError, { includeNotDir: false })) throw directoryError;
    }
    fileSystem.mkdirSync(currentDirectory, { mode: 0o700 });
    assertRealDirectory(currentDirectory, fileSystem);
  }
  try {
    fileSystem.chmodSync(directory, 0o700);
  } catch {}
}

function replaceFileAtomically(filePath: string, contents: string, fileSystem: AtomicWriteFileSystem): void {
  writeTextAtomicSync(filePath, contents, { mode: 0o600, exclusive: true, enforceMode: true, fsSync: fileSystem });
}

function writeAgentHooksFile(filePath: string, contents: string, fileSystem: SetupFileSystem): string | null {
  try {
    ensureWritableHooksDirectory(path.dirname(filePath), fileSystem);
    if (fileSystem.existsSync(filePath)) {
      const targetStat = fileSystem.lstatSync(filePath);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) return `Refusing to replace ${filePath}: the target is not a real file.`;
    }
    replaceFileAtomically(filePath, contents, fileSystem);
  } catch (writeError) {
    return `Could not write ${filePath}: ${errorMessage(writeError)}`;
  }
  return null;
}

interface AgentSetupDeps {
  env?: NodeJS.ProcessEnv;
  fileSystem?: SetupFileSystem;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

function runGrokSetup({ env, fileSystem, log, error }: Required<AgentSetupDeps>): number {
  const inputs = setupInputs(env);
  const expectedContents = renderGrokHooksFile(inputs);
  if (!expectedContents) {
    error("Could not render the Grok hooks file. Nothing was written.");
    return 1;
  }
  const inspection = inspectGrokAgentSetup({ env, readFileSync: fileSystem.readFileSync });
  if (inspection.classification === "current" && inspection.saneYoloReady) {
    log(`Grok hooks are already current at ${inputs.filePath}`);
    return 0;
  }
  if (inspection.classification === "foreign" || inspection.classification === "unreadable") {
    error(`Refusing to replace ${inputs.filePath}: the existing file is ${inspection.classification}.`);
    return 1;
  }
  const writeFailure = writeAgentHooksFile(inputs.filePath, expectedContents, fileSystem);
  if (writeFailure) {
    error(writeFailure);
    return 1;
  }
  log(`Installed Grok hooks at ${inputs.filePath}`);
  return 0;
}

const KIMI_REFUSAL_MESSAGES = {
  foreign: (filePath: string) => `Refusing to edit ${filePath}: its glimmervoid hooks block was edited by hand. Delete the block between the glimmervoid markers and run setup again.`,
  conflicting: (filePath: string) => `Refusing to edit ${filePath}: it defines hooks as a key or [hooks] table, which a [[hooks]] block would break. Rewrite those hooks as [[hooks]] tables and run setup again.`,
};

function readKimiConfig(filePath: string, readFileSync: ReadTextFile): { contents: string | null } | { reason: string } {
  try {
    return { contents: readFileSync(filePath, "utf8") };
  } catch (error) {
    if (isMissingFileError(error, { includeNotDir: false })) return { contents: null };
    return { reason: errorMessage(error) };
  }
}

function inspectKimiAgentSetup({ env = process.env, readFileSync = fs.readFileSync }: {
  env?: NodeJS.ProcessEnv;
  readFileSync?: ReadTextFile;
} = {}): AgentSetupInspection {
  const filePath = kimi.configFilePath(env);
  const expectedBlock = kimi.expectedHooksBlock();
  if (expectedBlock === null) return { filePath, classification: "unrenderable" };
  const config = readKimiConfig(filePath, readFileSync);
  if ("reason" in config) return { filePath, classification: "unreadable", reason: config.reason };
  return { filePath, classification: classifyKimiConfig(config.contents, expectedBlock) };
}

function runKimiSetup({ env, fileSystem, log, error }: Required<AgentSetupDeps>): number {
  const filePath = kimi.configFilePath(env);
  const expectedBlock = kimi.expectedHooksBlock();
  if (expectedBlock === null) {
    error("Could not render the Kimi Code hooks block. Nothing was written.");
    return 1;
  }
  const config = readKimiConfig(filePath, fileSystem.readFileSync);
  if ("reason" in config) {
    error(`Refusing to edit ${filePath}: the existing file is unreadable (${config.reason}).`);
    return 1;
  }
  const splice = spliceKimiHooksBlock(config.contents, expectedBlock);
  if ("refused" in splice) {
    error(KIMI_REFUSAL_MESSAGES[splice.refused](filePath));
    return 1;
  }
  if (!splice.changed) {
    log(`Kimi Code hooks are already current in ${filePath}`);
    return 0;
  }
  const writeFailure = writeAgentHooksFile(filePath, splice.contents, fileSystem);
  if (writeFailure) {
    error(writeFailure);
    return 1;
  }
  log(`Installed Kimi Code hooks in ${filePath}`);
  return 0;
}

function runAgentSetupCli(args: string[], deps: AgentSetupDeps = {}): number {
  const {
    env = process.env,
    fileSystem = fs,
    log = console.log,
    error = console.error,
  } = deps;
  if (args[0] === "setup" && args[1] === "grok" && args.length === 2) {
    return runGrokSetup({ env, fileSystem, log, error });
  }
  if (args[0] === "setup" && args[1] === "kimi" && args.length === 2) {
    return runKimiSetup({ env, fileSystem, log, error });
  }
  error(USAGE);
  return 1;
}

export { USAGE, runAgentSetupCli, inspectGrokAgentSetup, inspectKimiAgentSetup };
