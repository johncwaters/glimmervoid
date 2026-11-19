import { once } from 'node:events';
import readline from 'node:readline';
import { spawn } from '../child-process-safe.ts';
import { REMOVED_TEST_LINE_LIMIT } from '../../shared/contracts/verification.ts';
import type { RemovedTestLine } from '../../shared/contracts/verification.ts';
import { createTestKeepingScanner, TEST_FILE_PATHSPECS } from '../core/test-keeping-core.ts';

const SCAN_TIMEOUT_MS = 60_000;

async function streamRemovedTestLines(worktreeDir: string, baseSha: string): Promise<RemovedTestLine[] | null> {
  const scanner = createTestKeepingScanner(REMOVED_TEST_LINE_LIMIT);
  const args = ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', baseSha, '--', ...TEST_FILE_PATHSPECS];
  const child = spawn('git', args, { cwd: worktreeDir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
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

export { streamRemovedTestLines };
