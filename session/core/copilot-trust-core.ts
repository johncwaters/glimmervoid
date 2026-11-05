import path from "node:path";

import { cleanJsonc } from "../../server/core/tsconfig-paths-core.ts";
import { isRecord } from "../../shared/coerce.ts";

type CopilotFolderTrustDecision =
  | { kind: "trusted" }
  | { kind: "grant"; nextConfigText: string }
  | { kind: "unreadable"; reason: string };

function isFolderCoveredBy(folder: string, trustedFolder: string): boolean {
  const relativePath = path.relative(trustedFolder, folder);
  if (relativePath === "") return true;
  if (path.isAbsolute(relativePath)) return false;
  return relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`);
}

function leadingCommentLines(configText: string): string {
  const commentLines: string[] = [];
  for (const line of configText.split("\n")) {
    if (!line.trim().startsWith("//")) break;
    commentLines.push(`${line.trimEnd()}\n`);
  }
  return commentLines.join("");
}

function isFolderList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function decideCopilotFolderTrust(configText: string | null, folder: string): CopilotFolderTrustDecision {
  if (configText === null) return { kind: "grant", nextConfigText: `${JSON.stringify({ trustedFolders: [folder] }, null, 2)}\n` };
  const cleanedText = cleanJsonc(configText);
  let config: unknown = null;
  try {
    config = JSON.parse(cleanedText ?? "");
  } catch {
    return { kind: "unreadable", reason: "it is not valid JSON" };
  }
  if (!isRecord(config)) return { kind: "unreadable", reason: "it is not a JSON object" };
  const trustedFolders = config.trustedFolders ?? [];
  if (!isFolderList(trustedFolders)) return { kind: "unreadable", reason: "its trustedFolders is not a list of folders" };
  if (trustedFolders.some((trustedFolder) => isFolderCoveredBy(folder, trustedFolder))) return { kind: "trusted" };
  const nextConfig = { ...config, trustedFolders: [...trustedFolders, folder] };
  return { kind: "grant", nextConfigText: `${leadingCommentLines(configText)}${JSON.stringify(nextConfig, null, 2)}\n` };
}

function folderTrustRoot(sessionFolder: string, worktreeRoot: string | null): string {
  if (worktreeRoot && isFolderCoveredBy(sessionFolder, worktreeRoot)) return worktreeRoot;
  return sessionFolder;
}

export { folderTrustRoot, decideCopilotFolderTrust };
