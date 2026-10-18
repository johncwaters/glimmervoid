import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { execFileAsync } from '../../server/child-process-safe.ts';
import { glimmervoidHomeDir } from '../../server/config-store.ts';
import { factoryWrittenRecordId } from '../../server/factory/core/factory-core.ts';
import { captureFactoryLedgerRecord, commitAndLandFactoryLedger } from '../../server/factory/factory-ledger.ts';
import { createGitWorkspace } from '../../server/git/git-workspace.ts';
import { resolvePackageBin } from '../../server/runtime-paths.ts';
import { CoherenceOrient, CoherenceWorkInspect } from '../../shared/contracts/coherence.ts';
import type { FactoryUnlandedRecord } from '../../shared/contracts/factory.ts';

const REAL_PROCESS_TIMEOUT_MS = 30_000;

export const NATIVE_COHERENCE_CLAUDE_CONTROL: Readonly<Record<string, string>> = Object.freeze({
  '.claude/settings.json': '{}\n', '.claude/coherence-hook': '#!/bin/sh\n', '.claude/coherence-root': '.\n',
});

export async function writeNativeCoherenceControl(cwd: string): Promise<void> {
  for (const [relativePath, text] of Object.entries(NATIVE_COHERENCE_CLAUDE_CONTROL)) {
    await mkdir(path.dirname(path.join(cwd, relativePath)), { recursive: true });
    await writeFile(path.join(cwd, relativePath), text);
  }
}

export function stubEnvironmentVariable(context: TestContext, name: string, value: string): void {
  const previousValue = process.env[name];
  process.env[name] = value;
  context.after(() => {
    if (previousValue === undefined) { delete process.env[name]; return; }
    process.env[name] = previousValue;
  });
}

export function lanePrivateHome(): Promise<string> {
  return realpath(glimmervoidHomeDir());
}

export function gitRunnerIn(defaultCwd: string) {
  return async (args: string[], cwd = defaultCwd) => (await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: REAL_PROCESS_TIMEOUT_MS })).stdout.trim();
}

export async function initGitRepository(git: ReturnType<typeof gitRunnerIn>, branch: string, cwd?: string): Promise<void> {
  await git(['init', `--initial-branch=${branch}`], cwd);
  await git(['config', 'user.email', 'factory@example.test'], cwd);
  await git(['config', 'user.name', 'Factory'], cwd);
  await git(['config', 'commit.gpgsign', 'false'], cwd);
}

export async function createRepositoryWithOrigin(directory: string, branch: string, files: Record<string, string>) {
  const projectPath = path.join(directory, 'repo');
  const originPath = path.join(directory, 'origin.git');
  await mkdir(projectPath);
  const git = gitRunnerIn(projectPath);
  await git(['init', '--bare', `--initial-branch=${branch}`, originPath]);
  await initGitRepository(git, branch);
  for (const [relativePath, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(projectPath, relativePath)), { recursive: true });
    await writeFile(path.join(projectPath, relativePath), text);
  }
  await git(['add', '.']);
  await git(['commit', '-m', 'test: initialize']);
  await git(['remote', 'add', 'origin', originPath]);
  await git(['push', '-u', 'origin', branch]);
  return { projectPath, originPath, git };
}

export async function createLedgerRepository(directory: string, branch: string, files: Record<string, string>) {
  const repository = await createRepositoryWithOrigin(directory, branch, files);
  const gitWorkspace = createGitWorkspace();
  const ledger = await gitWorkspace.create({ projectPath: repository.projectPath, teamId: 'repo', label: 'factory-ledger', baseBranch: branch,
    configuredIntegrationBranch: branch, worktreeBase: directory, shareList: [] });
  return { ...repository, gitWorkspace, ledger };
}

export async function createCoherenceLedger(directory: string) {
  const repository = await createLedgerRepository(directory, 'integration', {
    'src/retry.ts': 'export const retries = 0;\n', 'coherence.config.json': '{}\n', ...NATIVE_COHERENCE_CLAUDE_CONTROL,
  });
  const { projectPath, ledger, gitWorkspace } = repository;
  const coherenceCli = resolvePackageBin('@danilocampos/coherence', 'coherence');
  assert.ok(coherenceCli);
  const commands: string[][] = [];
  const declaredFactoryRecords: FactoryUnlandedRecord[] = [];
  const runCoherence = async ({ cwd, args }: { cwd: string; args: string[] }) => {
    commands.push(args);
    const isFactoryWrite = args[args.indexOf('--session') + 1] === 'glimmervoid-factory';
    const writeArgs = isFactoryWrite && args[0] !== 'defect' && !args.includes('--json') ? [...args, '--json'] : args;
    const output = (await execFileAsync(process.execPath, [coherenceCli, ...writeArgs], { cwd, timeout: REAL_PROCESS_TIMEOUT_MS })).stdout;
    const recordId = isFactoryWrite ? factoryWrittenRecordId(output) : null;
    const writtenRecord = recordId ? await captureFactoryLedgerRecord(cwd, recordId, { args: writeArgs, output }) : null;
    if (writtenRecord && !declaredFactoryRecords.some(({ id }) => id === writtenRecord.id)) declaredFactoryRecords.push(writtenRecord);
    return output;
  };
  const createOrder = async ({ parent, objective, scope = parent ? 'src/retry.ts' : 'src', authority = 'user-directed' }: {
    parent: string | null; objective: string; scope?: string; authority?: string;
  }) => {
    const created: { work: string } = JSON.parse(await runCoherence({ cwd: ledger.cwd, args: [
      'work', 'create', objective, '--success', 'Retries pass', '--risk', 'medium', '--authority', authority,
      '--granted-by', 'operator', '--boundary', 'This repo', '--session', 'glimmervoid-factory', '--write-scope', scope,
      ...(parent ? ['--parent', parent] : []), '--json',
    ] }));
    return created.work;
  };
  const land = async (_projectId: string, _projectPath: string, message: string, { onCommitted }: { onCommitted?: () => Promise<void> } = {}) =>
    commitAndLandFactoryLedger({ projectPath, ledger, targetBranch: 'integration', message, gitWorkspace, declaredFactoryRecords, onCommitted });
  const inspect = async () => CoherenceWorkInspect.parse(JSON.parse(await runCoherence({ cwd: projectPath, args: ['work', 'inspect', '--json'] })));
  const orderState = async (workId: string) => (await inspect()).work.find((order) => order.work === workId)?.state;
  const readOrient = async () => {
    const orientText = await runCoherence({ cwd: projectPath, args: ['orient', '--json'] }).catch((error: unknown) => {
      if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') return error.stdout;
      throw error;
    });
    return CoherenceOrient.parse(JSON.parse(orientText));
  };
  const countLandedDefectsMentioning = async (summaryFragment: string) => {
    const listed: { defects: { summary: string }[] } = JSON.parse(await runCoherence({ cwd: projectPath, args: ['defects', '--json'] }));
    return listed.defects.filter((defect) => defect.summary.includes(summaryFragment)).length;
  };
  let projectChain: Promise<unknown> = Promise.resolve();
  const serializeProject = <T>(_projectId: string, operation: () => Promise<T>) => {
    const next = projectChain.then(operation, operation);
    projectChain = next;
    return next;
  };
  const settleProjectChain = async () => {
    let settledChain: Promise<unknown> | null = null;
    while (settledChain !== projectChain) {
      settledChain = projectChain;
      await settledChain.catch(() => {});
    }
  };
  return { ...repository, commands, declaredFactoryRecords, runCoherence, createOrder, land, inspect, orderState, readOrient, countLandedDefectsMentioning, serializeProject, settleProjectChain };
}
