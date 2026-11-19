import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { runCommandSafely, spawn } from '../child-process-safe.ts';
import { REMOVED_TEST_LINE_LIMIT } from '../../shared/contracts/verification.ts';
import type { RemovedTestLine } from '../../shared/contracts/verification.ts';
import { createTestKeepingScanner, TEST_FILE_PATHSPECS } from '../core/test-keeping-core.ts';

const SCAN_TIMEOUT_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 10_000;
const LOOKUP_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const NUL = String.fromCharCode(0);

const gitEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', ...extra });

async function gitOutput(worktreeDir: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string | null> {
  const result = await runCommandSafely('git', args, { cwd: worktreeDir, env: gitEnv(extraEnv), timeoutMs: LOOKUP_TIMEOUT_MS, maxBufferBytes: LOOKUP_MAX_BUFFER_BYTES });
  return result.ok ? result.stdout : null;
}

async function resolveScanBase(worktreeDir: string, baseSha: string | null, effectiveBase: string | null): Promise<string | null> {
  if (baseSha) return baseSha;
  const candidates = effectiveBase ? [`origin/${effectiveBase}`, effectiveBase, 'origin/HEAD'] : ['origin/HEAD'];
  for (const candidate of candidates) {
    const mergeBase = (await gitOutput(worktreeDir, ['merge-base', candidate, 'HEAD']))?.trim();
    if (mergeBase) return mergeBase;
  }
  return null;
}

async function indexWithUntrackedTests(worktreeDir: string, scratchDir: string): Promise<string | null> {
  const untracked = (await gitOutput(worktreeDir, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...TEST_FILE_PATHSPECS]))?.split(NUL).filter(Boolean) ?? [];
  if (untracked.length === 0) return null;
  const liveIndex = (await gitOutput(worktreeDir, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))?.trim();
  if (!liveIndex) return null;
  const scanIndex = path.join(scratchDir, 'index');
  const isCopied = await fs.promises.copyFile(liveIndex, scanIndex).then(() => true, () => false);
  if (!isCopied) return null;
  const added = await gitOutput(worktreeDir, ['add', '--intent-to-add', '--', ...untracked], { GIT_INDEX_FILE: scanIndex });
  return added === null ? null : scanIndex;
}

async function scanDiff(worktreeDir: string, base: string, scanIndex: string | null): Promise<RemovedTestLine[] | null> {
  const scanner = createTestKeepingScanner(REMOVED_TEST_LINE_LIMIT);
  const args = ['-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--text', '--no-textconv', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', base, '--', ...TEST_FILE_PATHSPECS];
  const child = spawn('git', args, { cwd: worktreeDir, env: gitEnv(scanIndex ? { GIT_INDEX_FILE: scanIndex } : {}), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const gitExitCode = once(child, 'close').then(([exitCode]) => (typeof exitCode === 'number' ? exitCode : null), () => null);
  if (!child.stdout) return null;
  const timer = setTimeout(() => child.kill(), SCAN_TIMEOUT_MS);
  let hasReachedLimit = false;
  for await (const patchLine of readline.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (!scanner.pushLine(patchLine)) continue;
    hasReachedLimit = true;
    child.kill();
    break;
  }
  const exitCode = await gitExitCode;
  clearTimeout(timer);
  if (exitCode !== 0 && !hasReachedLimit) return null;
  return scanner.finish();
}

async function streamRemovedTestLines(worktreeDir: string, baseSha: string | null, effectiveBase: string | null): Promise<RemovedTestLine[] | null> {
  const base = await resolveScanBase(worktreeDir, baseSha, effectiveBase);
  if (!base) return null;
  const scratchDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-test-keeping-'));
  try {
    return await scanDiff(worktreeDir, base, await indexWithUntrackedTests(worktreeDir, scratchDir));
  } finally {
    await fs.promises.rm(scratchDir, { recursive: true, force: true });
  }
}

export { streamRemovedTestLines };
