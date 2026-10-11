import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileAsync } from '../../server/child-process-safe.ts';
import { removeInside, resolveInside } from './cleanup.ts';
import { checkGate, runGit } from './gate.ts';
import type { TargetName } from './targets.ts';
import { createRepositoryWithOrigin } from '../../tests/helpers/factory-fixture.ts';

export interface BatchSnapshot {
  batchDirectory: string;
  snapshotPath: string;
  realMain: string;
  snapshotMain: string;
  snapshotRefCommits: string[];
}

export interface SeededTarget {
  projectPath: string;
  originPath: string;
  runDirectory: string;
  snapshot: BatchSnapshot | null;
}

export async function seedBatchSnapshot(batchDirectory: string, repositoryPath: string, signal?: AbortSignal): Promise<BatchSnapshot> {
  const snapshotPath = await resolveInside(batchDirectory, path.join(batchDirectory, 'staging.git'));
  const realMain = await runGit(repositoryPath, ['rev-parse', '--verify', 'refs/heads/main'], signal);
  await runGit(batchDirectory, ['clone', '--no-hardlinks', '--bare', '--single-branch', '--no-tags', '--branch', 'main', repositoryPath, snapshotPath], signal);
  await runGit(snapshotPath, ['remote', 'remove', 'origin'], signal);
  if (await runGit(snapshotPath, ['rev-parse', 'refs/heads/main'], signal) !== realMain) throw new Error('Gate refused: real main moved while taking the batch snapshot');
  const temporaryClone = await mkdtemp(path.join(batchDirectory, 'snapshot-setup-'));
  try {
    await runGit(batchDirectory, ['clone', '--no-hardlinks', snapshotPath, temporaryClone], signal);
    await writeFile(path.join(temporaryClone, 'coherence.config.json'), '{}\n');
    await runGit(temporaryClone, ['add', 'coherence.config.json'], signal);
    await runGit(temporaryClone, ['-c', 'user.name=Factory harness', '-c', 'user.email=factory@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test: enable coherence in gated snapshot'], signal);
    await runGit(temporaryClone, ['push', 'origin', 'HEAD:refs/heads/main'], signal);
  } finally { await removeInside(batchDirectory, temporaryClone); }
  const snapshotMain = await runGit(snapshotPath, ['rev-parse', '--verify', 'refs/heads/main'], signal);
  const snapshotRefCommits = (await runGit(snapshotPath, ['rev-list', '--no-walk', '--all'], signal)).split('\n').filter(Boolean);
  return { batchDirectory, snapshotPath, realMain, snapshotMain, snapshotRefCommits };
}

export async function seedTarget(directory: string, target: TargetName = 'throwaway', snapshot: BatchSnapshot | null = null, signal?: AbortSignal): Promise<SeededTarget> {
  if (target === 'gated-clone') {
    if (!snapshot) throw new Error('Gate refused: gated clone requires a batch snapshot');
    const originPath = await resolveInside(directory, path.join(directory, 'origin.git'));
    const projectPath = await resolveInside(directory, path.join(directory, 'repo'));
    await resolveInside(snapshot.batchDirectory, snapshot.snapshotPath);
    await runGit(directory, ['clone', '--no-hardlinks', '--bare', '--no-tags', snapshot.snapshotPath, originPath], signal);
    await runGit(originPath, ['remote', 'remove', 'origin'], signal);
    await runGit(directory, ['clone', '--no-hardlinks', originPath, projectPath], signal);
    await execFileAsync('npm', ['ci'], { cwd: projectPath, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, signal });
    const seeded = { projectPath, originPath, runDirectory: directory, snapshot };
    await checkGate(seeded, snapshot);
    return seeded;
  }
  const seeded = await seedThrowaway(directory);
  return { projectPath: seeded.projectPath, originPath: seeded.originPath, runDirectory: directory, snapshot: null };
}

async function seedThrowaway(directory: string) {
  return createRepositoryWithOrigin(directory, 'main', {
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test', typecheck: 'node --check src/math.js', lint: 'node --check src/math.js' } }),
    'coherence.config.json': '{}\n',
    'src/math.js': 'export function add(left, right) { return left + right; }\n',
    'test/math.test.js': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.js';\ntest('adds two numbers', () => assert.equal(add(2, 3), 5));\n",
  });
}
