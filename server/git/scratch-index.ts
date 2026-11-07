import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runGit } from './git-exec.ts';

type ScratchIndexEnv = { GIT_INDEX_FILE: string };
type ScratchIndexOutcome<T> = { ok: true; value: T } | { ok: false; reason: string };

async function copyIndexKeepingMtime(sourceIndex: string, scratchIndex: string): Promise<void> {
  await fsp.copyFile(sourceIndex, scratchIndex);
  const { atime, mtime } = await fsp.stat(sourceIndex);
  await fsp.utimes(scratchIndex, atime, mtime);
}

async function withScratchIndex<T>(
  worktreeDir: string,
  timeoutMs: number,
  readWithScratchIndex: (scratchIndexEnv: ScratchIndexEnv) => Promise<T>,
): Promise<ScratchIndexOutcome<T>> {
  const indexPath = await runGit(['rev-parse', '--git-path', 'index'], { cwd: worktreeDir, timeoutMs });
  if (!indexPath.ok) return { ok: false, reason: indexPath.err };
  const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-scratch-index-'));
  const scratchIndex = path.join(scratchDir, 'index');
  try {
    await copyIndexKeepingMtime(path.resolve(worktreeDir, indexPath.out.trim()), scratchIndex).catch(() => {});
    return { ok: true, value: await readWithScratchIndex({ GIT_INDEX_FILE: scratchIndex }) };
  } finally {
    await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

export { withScratchIndex };
export type { ScratchIndexEnv };
