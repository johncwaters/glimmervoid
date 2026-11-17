import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorCode } from '../../shared/text.ts';
import {
  CLAUDE_CONFIG_LOCK_STALE_MS, CLAUDE_CONFIG_LOCK_SUFFIX, decideFolderTrust, isConfigLockStale,
} from '../core/claude-trust-core.ts';
import { listClaudeGlobalConfigPathCandidates } from '../../server/core/claude-config-paths-core.ts';
import { writeTextAtomic } from '../../server/json-file.ts';
import { clock } from '../../shared/clock.ts';

type FolderTrustOutcome = 'already-trusted' | 'granted';

interface ClaudeFolderTrustOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  platform?: NodeJS.Platform;
  sleep?: Sleep;
}

type Sleep = (durationMs: number, signal: AbortSignal) => Promise<void>;

type LockAttempt = { kind: 'taken' } | { kind: 'gone' } | { kind: 'stuck' } | { kind: 'held'; instance: string; modifiedAtMs: number };

interface LockSighting {
  instance: string;
  modifiedAtMs: number;
  giveUpAtMs: number;
}

function sleepFor(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function startFolderWatch(folder: string, signal: AbortSignal, onChange: (changedName: string | null) => void): FSWatcher | null {
  try {
    return watch(folder, { persistent: false, signal }, (_eventType, changedName) => onChange(changedName));
  } catch {
    return null;
  }
}

function watchForLockChange(lockPath: string, signal: AbortSignal): Promise<void> {
  const lockName = path.basename(lockPath);
  return new Promise((resolve) => {
    const watcher = startFolderWatch(path.dirname(lockPath), signal, (changedName) => {
      if (changedName === null || changedName === lockName) resolve();
    });
    watcher?.on('error', () => watcher.close());
  });
}

async function tryTakeConfigLock(lockPath: string, now: () => number): Promise<LockAttempt> {
  try {
    await fs.mkdir(lockPath);
    return { kind: 'taken' };
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  const heldLock = await fs.lstat(lockPath).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (heldLock === null) return { kind: 'gone' };
  const instance = `${heldLock.ino}:${heldLock.birthtimeMs}`;
  if (!isConfigLockStale(heldLock.mtimeMs, now())) return { kind: 'held', instance, modifiedAtMs: heldLock.mtimeMs };
  const isRemoved = await fs.rmdir(lockPath).then(() => true, (error: unknown) => errorCode(error) === 'ENOENT');
  return isRemoved ? { kind: 'gone' } : { kind: 'stuck' };
}

function sightingOf(attempt: { instance: string; modifiedAtMs: number }, previous: LockSighting | null, now: () => number): LockSighting {
  if (previous?.instance === attempt.instance) return previous;
  return { instance: attempt.instance, modifiedAtMs: attempt.modifiedAtMs, giveUpAtMs: now() + CLAUDE_CONFIG_LOCK_STALE_MS };
}

async function takeClaudeConfigLock(configuredPath: string, { now = clock.nowMs, sleep = sleepFor }: { now?: () => number; sleep?: Sleep } = {}): Promise<string | null> {
  const lockPath = `${configuredPath}${CLAUDE_CONFIG_LOCK_SUFFIX}`;
  let sighting: LockSighting | null = null;
  for (;;) {
    const stopWaiting = new AbortController();
    try {
      const lockChange = watchForLockChange(lockPath, stopWaiting.signal);
      const attempt = await tryTakeConfigLock(lockPath, now);
      if (attempt.kind === 'taken') return lockPath;
      if (attempt.kind === 'stuck') return null;
      if (attempt.kind === 'held') {
        sighting = sightingOf(attempt, sighting, now);
        const staleAtMs = attempt.modifiedAtMs + CLAUDE_CONFIG_LOCK_STALE_MS;
        const isUntouchedSinceFirstSight = attempt.modifiedAtMs === sighting.modifiedAtMs && attempt.modifiedAtMs <= now();
        if (now() > sighting.giveUpAtMs && !isUntouchedSinceFirstSight) return null;
        const wakeAtMs = isUntouchedSinceFirstSight ? staleAtMs : Math.min(staleAtMs, sighting.giveUpAtMs);
        await Promise.race([lockChange, sleep(wakeAtMs - now() + 1, stopWaiting.signal)]);
      }
    } finally {
      stopWaiting.abort();
    }
  }
}

function createClaudeFolderTrust({ env = process.env, homeDir = os.homedir(), now = clock.nowMs, platform = process.platform, sleep = sleepFor }: ClaudeFolderTrustOptions = {}) {
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

  async function ensureTrusted(repositoryRoot: string): Promise<FolderTrustOutcome> {
    const configuredPath = await resolveConfiguredPath();
    const configPath = await fs.realpath(configuredPath).catch(() => configuredPath);
    if ((await readTrustDecision(repositoryRoot, configPath)).kind === 'trusted') return 'already-trusted';
    const lockPath = await takeClaudeConfigLock(configuredPath, { now, sleep });
    if (lockPath === null) throw refusal(repositoryRoot, configuredPath, 'another process holds its lock');
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

export { createClaudeFolderTrust, takeClaudeConfigLock };
