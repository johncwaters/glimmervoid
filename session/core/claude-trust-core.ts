import path from 'node:path';

const CLAUDE_CONFIG_LOCK_SUFFIX = '.lock';
const CLAUDE_CONFIG_LOCK_STALE_MS = 10_000;
const CLAUDE_CONFIG_LOCK_RETRY_DELAYS_MS = Object.freeze([200, 400, 800, 1600]);

type FolderTrustDecision =
  | { kind: 'trusted' }
  | { kind: 'grant'; nextConfigText: string }
  | { kind: 'unreadable'; reason: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function newProjectEntry(): Record<string, unknown> {
  return { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [] };
}

function claudeProjectKeyOf(folderPath: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return path.posix.normalize(folderPath);
  return path.win32.normalize(folderPath).replaceAll('\\', '/');
}

function isConfigLockStale(lockModifiedMs: number, nowMs: number): boolean {
  return nowMs - lockModifiedMs > CLAUDE_CONFIG_LOCK_STALE_MS;
}

function decideFolderTrust(configText: string, repositoryRoot: string, platform: NodeJS.Platform): FolderTrustDecision {
  const projectKey = claudeProjectKeyOf(repositoryRoot, platform);
  let config: unknown;
  try {
    config = JSON.parse(configText);
  } catch {
    return { kind: 'unreadable', reason: 'it is not valid JSON' };
  }
  if (!isPlainRecord(config)) return { kind: 'unreadable', reason: 'it is not a JSON object' };
  const projects = config.projects ?? {};
  if (!isPlainRecord(projects)) return { kind: 'unreadable', reason: 'its projects key is not an object' };
  const existingEntry = projects[projectKey];
  if (existingEntry !== undefined && !isPlainRecord(existingEntry)) return { kind: 'unreadable', reason: 'its entry for this folder is not an object' };
  if (existingEntry?.hasTrustDialogAccepted === true) return { kind: 'trusted' };
  const trustedEntry = { ...(existingEntry ?? newProjectEntry()), hasTrustDialogAccepted: true };
  const nextConfigText = JSON.stringify({ ...config, projects: { ...projects, [projectKey]: trustedEntry } }, null, 2);
  return { kind: 'grant', nextConfigText: configText.endsWith('\n') ? `${nextConfigText}\n` : nextConfigText };
}

export {
  CLAUDE_CONFIG_LOCK_RETRY_DELAYS_MS,
  CLAUDE_CONFIG_LOCK_STALE_MS,
  CLAUDE_CONFIG_LOCK_SUFFIX,
  decideFolderTrust,
  isConfigLockStale,
};
