import { cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' && process.platform !== 'darwin') {
  console.error('Factory check sandbox requires Linux or macOS');
  process.exit(2);
}

const argumentsPassed = process.argv.slice(2);
const shouldOverlayWorkingTree = argumentsPassed[0] === '--working-tree';
if (shouldOverlayWorkingTree) argumentsPassed.shift();
if (argumentsPassed.shift() !== '--' || argumentsPassed.length === 0) {
  console.error('Usage: node test/factory/check-sandbox.ts [--working-tree] -- <command> [args...]');
  process.exit(2);
}

const commandController = new AbortController();
const terminationSignals = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
const interruptCommand = (terminationSignal: NodeJS.Signals) => {
  commandController.abort();
  process.exitCode = 128 + os.constants.signals[terminationSignal];
};
for (const terminationSignal of terminationSignals) process.on(terminationSignal, interruptCommand);

const checkoutParent = await mkdtemp(path.join(os.tmpdir(), 'glimmervoid-factory-checks-'));
const checkoutPath = path.join(checkoutParent, 'checkout');

try {
  const { isMissingFileError } = await import('../../shared/text.ts');
  const { prepareSandboxedCheckRunner } = await import('../../server/factory-check-sandbox.ts');
  const { createGitWorkspace, runHardenedGit } = await import('../../server/git/git-workspace.ts');
  const { DEFAULT_CONFIG } = await import('../../server/config-store.ts');
  const { buildFactoryCheckEnv } = await import('../../server/core/factory-core.ts');
  const { nulSeparatedPaths } = await import('../../server/git/core/git-changed-paths-core.ts');
  const projectPath = fileURLToPath(new URL('../../', import.meta.url));
  const checkEnv = buildFactoryCheckEnv(process.env, process.platform);
  const isolation = { disableHooks: true, disableRepoCommands: true, replaceEnv: checkEnv };
  const gitWorkspace = createGitWorkspace();
  const runGit = async (args: string[]) => (await runHardenedGit(args, {
    cwd: projectPath, env: checkEnv, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  })).stdout;
  const headSha = (await runGit(['rev-parse', 'HEAD'])).trim();
  const falseWhenPathIsGone = (failure: unknown) => {
    if (isMissingFileError(failure)) return false;
    throw failure;
  };
  try {
    const staged = await gitWorkspace.stageDetachedWorktree({ projectPath, worktreePath: checkoutPath, sha: headSha, ...isolation });
    if (!staged.ok) throw new Error(`Could not stage the factory check checkout: ${staged.err}`);
    await gitWorkspace.populate({ projectPath, wtDir: checkoutPath, shareList: DEFAULT_CONFIG.worktreeShare, ...isolation });
    if (shouldOverlayWorkingTree) {
      const modifiedPaths = nulSeparatedPaths(await runGit(['diff', 'HEAD', '--name-only', '--no-renames', '-z']));
      const untrackedPaths = nulSeparatedPaths(await runGit(['ls-files', '--others', '--exclude-standard', '-z']));
      for (const relativePath of new Set([...modifiedPaths, ...untrackedPaths])) {
        const sourcePath = path.join(projectPath, relativePath);
        const destinationPath = path.join(checkoutPath, relativePath);
        await rm(destinationPath, { recursive: true, force: true }).catch(falseWhenPathIsGone);
        const sourceExists = await lstat(sourcePath).then(() => true, falseWhenPathIsGone);
        if (!sourceExists) continue;
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await cp(sourcePath, destinationPath, { recursive: true, verbatimSymlinks: true });
      }
    }
    commandController.signal.throwIfAborted();
    const sandbox = await prepareSandboxedCheckRunner({ scratchParent: checkoutParent, writablePaths: [checkoutPath] });
    try {
      const output = await sandbox.runCheck(argumentsPassed, {
        cwd: checkoutPath, env: checkEnv, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, signal: commandController.signal,
      });
      process.stdout.write(output.stdout);
      process.stderr.write(output.stderr);
    } finally {
      await sandbox.dispose();
    }
  } finally {
    const removed = await gitWorkspace.removeWorktreeByPath({ projectPath, cwd: checkoutPath, ...isolation });
    if (!removed.ok) {
      await rm(checkoutPath, { recursive: true, force: true });
      const pruned = await gitWorkspace.pruneWorktrees({ projectPath, ...isolation });
      if (!pruned.ok) {
        console.error(`Could not prune the factory check checkout: ${pruned.err}`);
        process.exitCode = process.exitCode || 1;
      }
    }
  }
} catch (failure) {
  if (!(failure instanceof Error)) throw failure;
  for (const stream of ['stdout', 'stderr'] as const) {
    const captured: unknown = Reflect.get(failure, stream);
    if (typeof captured === 'string') process[stream].write(captured);
  }
  const exitCode: unknown = Reflect.get(failure, 'code');
  if (!commandController.signal.aborted) {
    process.exitCode = typeof exitCode === 'number' ? exitCode : 1;
    if (typeof exitCode !== 'number') console.error(failure.message);
  }
} finally {
  await rm(checkoutParent, { recursive: true, force: true });
  for (const terminationSignal of terminationSignals) process.off(terminationSignal, interruptCommand);
}
