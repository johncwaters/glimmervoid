import fs from "node:fs";
import path from "node:path";

import { writeTextAtomicSync } from "../server/json-file.ts";
import { errorMessage } from "../shared/text.ts";
import { readOptionalText } from "./agent-home.ts";
import { decideCopilotFolderTrust } from "./core/copilot-trust-core.ts";

const NEW_CONFIG_MODE = 0o600;

function realPathOrSelf(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function existingModeOr(filePath: string, fallbackMode: number): number {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return fallbackMode;
  }
}

function isSessionCopy(sessionStatePath: string, realStatePath: string): boolean {
  try {
    const sessionStat = fs.lstatSync(sessionStatePath);
    if (!sessionStat.isFile()) return false;
    const realStat = fs.statSync(realStatePath, { throwIfNoEntry: false });
    return !realStat || realStat.dev !== sessionStat.dev || realStat.ino !== sessionStat.ino;
  } catch {
    return false;
  }
}

function copilotStateFileToTrust(realStatePath: string, sessionStatePath: string): string {
  return isSessionCopy(sessionStatePath, realStatePath) ? sessionStatePath : realStatePath;
}

function ensureCopilotFolderTrust(configPath: string, folder: string): string | null {
  const resolvedConfigPath = realPathOrSelf(configPath);
  try {
    const decision = decideCopilotFolderTrust(readOptionalText(resolvedConfigPath), folder);
    if (decision.kind === "trusted") return null;
    if (decision.kind === "unreadable") return `${folder} stays untrusted for Copilot CLI: ${resolvedConfigPath} was left unchanged because ${decision.reason}`;
    writeTextAtomicSync(resolvedConfigPath, decision.nextConfigText, { mode: existingModeOr(resolvedConfigPath, NEW_CONFIG_MODE), mkdir: true });
    return null;
  } catch (error) {
    return `${folder} stays untrusted for Copilot CLI: ${path.basename(resolvedConfigPath)} could not be updated (${errorMessage(error)})`;
  }
}

export { copilotStateFileToTrust, ensureCopilotFolderTrust };
