import fs from 'node:fs/promises';
import os from 'node:os';
import { errorCode } from '../shared/text.ts';
import {
  CLAUDE_CONFIG_LOCK_RETRY_DELAYS_MS, CLAUDE_CONFIG_LOCK_SUFFIX, decideFolderTrust, isConfigLockStale, listClaudeGlobalConfigPathCandidates,
} from './core/claude-trust-core.ts';
import { writeTextAtomic } from './json-file.ts';

type FolderTrustOutcome = 'already-trusted' | 'granted';

interface ClaudeFolderTrustOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  sleep?: (durationMs: number) => Promise<void>;
}

function sleepFor(durationMs: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, durationMs); });
}

function createClaudeFolderTrust({ env = process.env, homeDir = os.homedir(), now = Date.now, platform = process.platform, sleep = sleepFor }: ClaudeFolderTrustOptions = {}) {
  async function resolveConfiguredPath(): Promise<string> {
    const [legacyConfigPath, currentConfigPath] = listClaudeGlobalConfigPathCandidates(env, homeDir);
    const hasLegacyConfig = await fs.access(legacyConfigPath).then(() => true, () => false);
    return hasLegacyConfig ? legacyConfigPath : currentConfigPath;
  }

  function refusal(repositoryRoot: string, configPath: string, reason: string): Error {
    return new Error(`Could not trust ${repositoryRoot} for Claude Code: ${configPath} was left unchanged because ${reason}`);
  }

  async function readTrustDecision(repositoryRoot: string, configPath: string) {
    const configText = await fs.readFile(configPath, 'utf8').catch((error: unknown) => {
      throw refusal(repositoryRoot, configPath, `it could not be read (${errorCode(error) ?? 'unknown error'})`);
    });
    const decision = decideFolderTrust(configText, repositoryRoot, platform);
    if (decision.kind === 'unreadable') throw refusal(repositoryRoot, configPath, decision.reason);
    return decision;
  }

  async function tryTakeConfigLock(lockPath: string): Promise<boolean> {
    try {
      await fs.mkdir(lockPath);
      return true;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const heldLock = await fs.stat(lockPath).catch(() => null);
    if (heldLock && isConfigLockStale(heldLock.mtimeMs, now())) await fs.rmdir(lockPath).catch(() => {});
    return false;
  }

  async function takeConfigLock(repositoryRoot: string, configuredPath: string): Promise<string> {
    const lockPath = `${configuredPath}${CLAUDE_CONFIG_LOCK_SUFFIX}`;
    for (const delayMs of [0, ...CLAUDE_CONFIG_LOCK_RETRY_DELAYS_MS]) {
      if (delayMs > 0) await sleep(delayMs);
      if (await tryTakeConfigLock(lockPath)) return lockPath;
    }
    throw refusal(repositoryRoot, configuredPath, 'another process holds its lock');
  }

  async function ensureTrusted(repositoryRoot: string): Promise<FolderTrustOutcome> {
    const configuredPath = await resolveConfiguredPath();
    const configPath = await fs.realpath(configuredPath).catch(() => configuredPath);
    if ((await readTrustDecision(repositoryRoot, configPath)).kind === 'trusted') return 'already-trusted';
    const lockPath = await takeConfigLock(repositoryRoot, configuredPath);
    try {
      const decision = await readTrustDecision(repositoryRoot, configPath);
      if (decision.kind === 'trusted') return 'already-trusted';
      const { mode } = await fs.stat(configPath);
      await writeTextAtomic(configPath, decision.nextConfigText, { mode: mode & 0o777 });
      return 'granted';
    } finally {
      await fs.rmdir(lockPath).catch(() => {});
    }
  }

  return { ensureTrusted };
}

export { createClaudeFolderTrust };
