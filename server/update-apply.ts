import fs from 'node:fs';
import path from 'node:path';

import { UpdateJournal as UpdateJournalSchema } from '../shared/contracts/update-journal.ts';
import type {
  UpdateChannel,
  UpdateJournal,
  UpdateStepId,
} from '../shared/contracts/update-journal.ts';
import { execFileAsync } from './child-process-safe.ts';
import {
  appendTail,
  beginRun,
  beginStep,
  decideFastForward,
  decideNpmGlobalLayout,
  decidePreflight,
  failRun,
  finishStep,
  markDiscarded,
  markInterrupted,
  markStaged,
  markSucceeded,
  idleJournal,
  interruptedDisplayJournal,
  lowPriorityCommand,
  planHandOffRenames,
  planNpmGlobalHandOffRenames,
  planSteps,
  PREVIOUS_DEPENDENCIES_BACKUP_NAME,
  PREVIOUS_DIST_BACKUP_NAME,
  QUARANTINED_DEPENDENCIES_NAME,
  QUARANTINED_DIST_NAME,
  retireAtBoot,
} from './core/update-apply-core.ts';
import type { NpmGlobalInstall, NpmGlobalLayout, RenameOperation } from './core/update-apply-core.ts';
import { NODE_PTY_INSTALL_SCRIPT_FLAG } from './core/update-core.ts';
import { stableNodePath } from './stable-node-path.ts';
import type { GitWorkspaceInstance } from './git/git-workspace.ts';
import { runCommand as execCommand, runGit } from './git/git-exec.ts';
import type { CommandResult } from './git/git-exec.ts';
import { createJsonStateWriter, writeJsonAtomic } from './json-file.ts';
import { isMissingFileError } from '../shared/text.ts';
import { probeBranchAndUpstream } from './update-check.ts';
import type { UpdateStatus } from './backend/backend-update.ts';

const FETCH_TIMEOUT_MS = 60_000;
const HANDOFF_QUEUE_ADMISSION_TIMEOUT_MS = 30_000;
const MERGE_COMMAND_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 60_000;
const SUCCESSOR_LISTEN_TIMEOUT_MS = 30_000;
const SUCCESSOR_POLL_INTERVAL_MS = 500;
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
const RESTORE_MARKER_NAME = 'restore.json';

type UpdateFileSystem = Pick<
  typeof fs.promises,
  'access' | 'appendFile' | 'mkdir' | 'readFile' | 'rename' | 'rm' | 'symlink' | 'writeFile'
>;
type RunCommand = typeof execFileAsync;
type UpdateGitWorkspace = Pick<
  GitWorkspaceInstance,
  'fetchOrigin' | 'mergeFastForwardTo' | 'probeWorktreeDirty' | 'removeWorktreeByPath' | 'resetKeepTo' | 'stageDetachedWorktree'
>;

interface UpdateApplyDependencies {
  gitWorkspace: UpdateGitWorkspace;
  runCommand?: RunCommand;
  fsPromises?: UpdateFileSystem;
  packageRoot: string;
  journalPath: string;
  getUpdateStatus: () => UpdateStatus | null;
  getUpdateChannel: () => UpdateChannel;
  broadcastControl: (message: Record<string, unknown>) => void;
  logger: Pick<Console, 'log' | 'warn'>;
  clock?: () => number;
  platform?: NodeJS.Platform;
  nodePath?: string;
}


interface UpdateApplyOutcome {
  ok: boolean;
  reason: string | null;
  message: string;
}

interface ListeningServer {
  listening: boolean;
  once(event: 'listening', listener: () => void): unknown;
  removeListener(event: 'listening', listener: () => void): unknown;
}

interface NpmGlobalStagedDescriptor {
  state: 'staged';
  kind: 'npm-global';
  layout: NpmGlobalLayout;
}

interface CloneStagedDescriptor {
  state: 'staged';
  kind: 'clone';
  fromSha: string;
  targetSha: string;
  lockfileChanged: boolean;
  stagingPath: string;
}

type StagedDescriptor = CloneStagedDescriptor | NpmGlobalStagedDescriptor;

interface SuccessorProcess {
  once(event: 'exit', listener: () => void): unknown;
}

type SuccessorFate = 'exited' | 'listening' | 'still-starting';

interface CommandOutcome {
  ok: boolean;
  output: string;
  reason: string | null;
}

interface UpdateApplyLane {
  applyUpdate(): Promise<UpdateApplyOutcome>;
  getJournal(): UpdateJournal;
  getNpmGlobalInstall(): NpmGlobalInstall | null;
  handOffStagedUpdate(): Promise<void>;
  superviseSuccessor(successor: SuccessorProcess): Promise<boolean>;
  isRestartRequested(): boolean;
  noteRestartRequested(): void;
  startAfterListening(httpServer: ListeningServer): void;
  stop(): Promise<void>;
  whenIdle(): Promise<void>;
}

interface PersistedJournalRead {
  journal: UpdateJournal;
  wasPersisted: boolean;
}

function errorText(error: unknown): string {
  const commandError = error as { stdout?: unknown; stderr?: unknown; message?: unknown } | null;
  return String(commandError?.stderr || commandError?.stdout || commandError?.message || error || 'command failed').trim();
}

function appendStepOutput(journal: UpdateJournal, stepId: UpdateStepId, output: string): UpdateJournal {
  if (!output) return journal;
  return {
    ...journal,
    steps: journal.steps.map((step) => step.id === stepId
      ? { ...step, outputTail: appendTail(step.outputTail, output) }
      : step),
  };
}

function refusal(reason: string, message: string): UpdateApplyOutcome {
  return { ok: false, reason, message };
}

function createUpdateApplyLane(dependencies: UpdateApplyDependencies): UpdateApplyLane {
  const runCommand = dependencies.runCommand || execFileAsync;
  const fsPromises = dependencies.fsPromises || fs.promises;
  const clock = dependencies.clock || (() => Date.now());
  const updatePath = path.join(dependencies.packageRoot, '.glimmervoid', 'update');
  const stagingPath = path.join(updatePath, 'next');
  const npmGlobalLayout = decideNpmGlobalLayout(dependencies.packageRoot);
  const nodePath = dependencies.nodePath || stableNodePath;
  const npmPath = path.join(path.dirname(nodePath), 'npm');
  let isInstallWritable: boolean | null = null;
  let hasSwappedNpmGlobalPackage = false;
  let journal = idleJournal(dependencies.getUpdateChannel());
  let stagedDescriptor: StagedDescriptor | null = null;
  let inFlight = false;
  let restartRequested = false;
  let activeRun: Promise<unknown> = Promise.resolve();
  let bootRun: Promise<void> = Promise.resolve();
  let pendingListeningServer: ListeningServer | null = null;
  let pendingListeningStart: (() => void) | null = null;
  let persistenceFailure: unknown = null;
  const journalWriter = createJsonStateWriter({
    filePath: dependencies.journalPath,
    fsPromises,
    warn: (error) => {
      persistenceFailure = error;
      dependencies.logger.warn(`[update] journal write failed: ${errorText(error)}`);
    },
  });

  function getJournal(): UpdateJournal {
    return structuredClone(journal);
  }

  function getNpmGlobalInstall(): NpmGlobalInstall | null {
    if (!npmGlobalLayout) return null;
    return { installFolder: npmGlobalLayout.installFolder, isWritable: isInstallWritable };
  }

  async function refreshInstallWritability(): Promise<void> {
    if (!npmGlobalLayout) return;
    try {
      await fsPromises.access(npmGlobalLayout.installFolder, fs.constants.W_OK);
      isInstallWritable = true;
    } catch {
      isInstallWritable = false;
    }
  }

  async function publish(nextJournal: UpdateJournal, failOnWrite = true): Promise<void> {
    journal = nextJournal;
    persistenceFailure = null;
    await journalWriter.write(journal, () => JSON.stringify(journal, null, 2));
    dependencies.broadcastControl({ type: 'update-progress', journal: getJournal() });
    if (!failOnWrite || persistenceFailure === null) return;
    throw new Error(`journal-write-failed: ${errorText(persistenceFailure)}`);
  }

  function commandOutcome(result: CommandResult): CommandOutcome {
    if (result.ok) return { ok: true, output: [result.out, result.stderr].filter(Boolean).join('\n'), reason: null };
    return { ok: false, output: errorText(result.error), reason: errorText(result.error) };
  }

  async function command(file: string, args: string[], cwd: string, timeout: number): Promise<CommandOutcome> {
    return commandOutcome(await execCommand(file, args, { cwd, timeoutMs: timeout, maxBuffer: COMMAND_MAX_BUFFER, trim: false, execFileFn: runCommand }));
  }

  async function gitCommand(args: string[], cwd = dependencies.packageRoot): Promise<CommandOutcome> {
    return commandOutcome(await runGit(args, { cwd, timeoutMs: FETCH_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER, trim: false, execFileFn: runCommand }));
  }

  async function runWorkspaceStep(
    stepId: UpdateStepId,
    run: () => Promise<{ ok: boolean; out: string; err?: string }>,
  ): Promise<void> {
    await publish(beginStep(journal, { stepId, now: clock() }));
    const outcome = await run();
    journal = appendStepOutput(journal, stepId, [outcome.out, outcome.err].filter(Boolean).join('\n'));
    if (!outcome.ok) throw new Error(outcome.err || `${stepId} failed`);
    await publish(finishStep(journal, { stepId, now: clock() }));
  }

  async function runCommandStep(
    stepId: UpdateStepId,
    file: string,
    args: string[],
    cwd: string,
    timeout: number,
  ): Promise<void> {
    await publish(beginStep(journal, { stepId, now: clock() }));
    const throttled = lowPriorityCommand({ file, args, platform: dependencies.platform || process.platform });
    const outcome = await command(throttled.file, throttled.args, cwd, timeout);
    journal = appendStepOutput(journal, stepId, outcome.output);
    if (!outcome.ok) throw new Error(outcome.reason || `${stepId} failed`);
    await publish(finishStep(journal, { stepId, now: clock() }));
  }

  function replaceRemainingStepPlan(lockfileChanged: boolean): UpdateJournal {
    const priorSteps = new Map(journal.steps.map((step) => [step.id, step]));
    return {
      ...journal,
      steps: planSteps({ lockfileChanged }).map((id) => priorSteps.get(id) || {
        id,
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        outputTail: [],
      }),
    };
  }

  async function failAndClean(reason: string, message = reason): Promise<UpdateApplyOutcome> {
    stagedDescriptor = null;
    await dependencies.gitWorkspace.removeWorktreeByPath({
      projectPath: dependencies.packageRoot,
      cause: 'update-apply',
      cwd: stagingPath,
    });
    await publish(failRun(journal, { reason, now: clock() }), false);
    return refusal(reason, message);
  }

  async function stageUpdate(): Promise<UpdateApplyOutcome> {
    const status = dependencies.getUpdateStatus();
    const channel = dependencies.getUpdateChannel();
    if (!status) return refusal('missing-update-status', 'Check for updates before applying one.');
    if (journal.state === 'staged' || stagedDescriptor?.state === 'staged') {
      return refusal('already-staged', 'Restart to apply the staged update.');
    }
    if (restartRequested) return refusal('restart-requested', 'Wait for the requested restart to finish.');
    if (status.flavor === 'npm-global') return stageNpmGlobalUpdate(status, channel);
    const tree = await dependencies.gitWorkspace.probeWorktreeDirty({
      projectPath: dependencies.packageRoot,
      cwd: dependencies.packageRoot,
    });
    const checkout = await probeBranchAndUpstream(async (args) => {
      const probe = await gitCommand(args);
      return { ok: probe.ok, out: probe.output.trim() };
    });
    const decision = decidePreflight({
      flavor: status.flavor,
      platform: dependencies.platform || process.platform,
      statusChannel: status.channel,
      configuredChannel: channel,
      updateAvailable: status.updateAvailable,
      isTreeClean: tree.ok && !tree.dirty,
      branch: checkout.branch,
      upstream: checkout.upstream,
      statusBranch: status.installedBranch,
      statusUpstream: status.upstream,
      headSha: tree.headSha,
      targetSha: status.latestSha,
      journalState: journal.state,
      restartRequested,
    });
    if (!decision.ok) return refusal(decision.reason, decision.message);
    if (!tree.headSha || !status.latestSha) return refusal('missing-target-sha', 'The target sha is unknown. Check for updates again.');

    try {
      await fsPromises.mkdir(updatePath, { recursive: true });
      await publish(beginRun(journal, {
        stepIds: ['fetch', 'stage'],
        fromSha: status.currentSha,
        toSha: status.latestSha,
        toVersion: status.latest,
        channel,
        now: clock(),
      }));
      await runWorkspaceStep('fetch', () => dependencies.gitWorkspace.fetchOrigin({
        projectPath: dependencies.packageRoot,
        timeoutMs: FETCH_TIMEOUT_MS,
      }));
      const fastForwardProbe = await gitCommand(['merge-base', '--is-ancestor', tree.headSha, status.latestSha]);
      let isTargetAncestorOfHead = false;
      if (!fastForwardProbe.ok) {
        const alreadyCheckedOutProbe = await gitCommand([
          'merge-base', '--is-ancestor', status.latestSha, tree.headSha,
        ]);
        isTargetAncestorOfHead = alreadyCheckedOutProbe.ok;
      }
      const fastForward = decideFastForward({
        canFastForward: fastForwardProbe.ok,
        isTargetAncestorOfHead,
      });
      if (!fastForward.ok) return failAndClean(fastForward.reason, fastForward.message);
      await runWorkspaceStep('stage', () => dependencies.gitWorkspace.stageDetachedWorktree({
        projectPath: dependencies.packageRoot,
        worktreePath: stagingPath,
        sha: status.latestSha || undefined,
        owner: 'lane:update-apply',
      }));
      const lockfileDiff = await gitCommand([
        'diff', '--name-only', `${tree.headSha}..${status.latestSha}`, '--', 'package-lock.json',
      ]);
      if (!lockfileDiff.ok) throw new Error(`lockfile-check-failed: ${lockfileDiff.reason}`);
      const lockfileChanged = lockfileDiff.output.split(/\r?\n/).some((name) => name.trim() === 'package-lock.json');
      await publish(replaceRemainingStepPlan(lockfileChanged));
      if (lockfileChanged) {
        await runCommandStep('install', 'npm', ['ci'], stagingPath, INSTALL_TIMEOUT_MS);
        await publish(beginStep(journal, { stepId: 'build', now: clock() }));
        await publish(finishStep(journal, { stepId: 'build', now: clock() }));
      }
      if (!lockfileChanged) {
        await publish(beginStep(journal, { stepId: 'link-deps', now: clock() }));
        await fsPromises.symlink(path.join(dependencies.packageRoot, 'node_modules'), path.join(stagingPath, 'node_modules'), 'dir');
        await publish(finishStep(journal, { stepId: 'link-deps', now: clock() }));
        await runCommandStep('build', 'npm', ['run', 'build'], stagingPath, BUILD_TIMEOUT_MS);
      }
      await publish(markStaged(journal, { now: clock() }));
      stagedDescriptor = {
        state: 'staged',
        kind: 'clone',
        fromSha: tree.headSha,
        targetSha: status.latestSha,
        lockfileChanged,
        stagingPath,
      };
      dependencies.logger.log(`[update] staged ${status.latestSha}`);
      return { ok: true, reason: null, message: 'Update staged. Restart to apply it.' };
    } catch (error) {
      return failAndClean(errorText(error));
    }
  }

  function applyUpdate(): Promise<UpdateApplyOutcome> {
    if (inFlight) return Promise.resolve(refusal('already-running', 'Wait for the current update to finish.'));
    inFlight = true;
    const run = bootRun.then(() => stageUpdate()).finally(() => { inFlight = false; });
    activeRun = run;
    return run;
  }

  async function stageNpmGlobalUpdate(status: UpdateStatus, channel: UpdateChannel): Promise<UpdateApplyOutcome> {
    await refreshInstallWritability();
    const decision = decidePreflight({
      flavor: status.flavor,
      platform: dependencies.platform || process.platform,
      statusChannel: status.channel,
      configuredChannel: channel,
      updateAvailable: status.updateAvailable,
      isTreeClean: false,
      branch: null,
      upstream: null,
      statusBranch: null,
      statusUpstream: null,
      headSha: null,
      targetSha: null,
      journalState: journal.state,
      restartRequested,
      npmGlobalInstall: getNpmGlobalInstall(),
    });
    if (!decision.ok) return refusal(decision.reason, decision.message);
    if (!npmGlobalLayout || !status.latest) return refusal('missing-target-version', 'The target version is unknown. Check for updates again.');
    const layout = npmGlobalLayout;
    const targetVersion = status.latest;
    try {
      await publish(beginRun(journal, {
        stepIds: ['install'],
        fromSha: status.currentSha,
        toSha: status.latestSha,
        toVersion: targetVersion,
        channel,
        now: clock(),
      }));
      await fsPromises.rm(layout.stagePrefix, { recursive: true, force: true });
      await fsPromises.mkdir(layout.stagePrefix, { recursive: true });
      await publish(beginStep(journal, { stepId: 'install', now: clock() }));
      await runNpmGlobalInstall(layout, targetVersion);
      await verifyStagedPackage(layout, targetVersion);
      await publish(finishStep(journal, { stepId: 'install', now: clock() }));
      await publish(markStaged(journal, { now: clock() }));
      stagedDescriptor = { state: 'staged', kind: 'npm-global', layout };
      dependencies.logger.log(`[update] staged glimmervoid@${targetVersion} in ${layout.stagedPackagePath}`);
      return { ok: true, reason: null, message: 'Update staged. Restart to apply it.' };
    } catch (error) {
      return failAndCleanNpmGlobal(layout, errorText(error));
    }
  }

  async function runInstallCommand(file: string, args: string[], cwd: string, timeout: number): Promise<string> {
    const outcome = await command(file, args, cwd, timeout);
    journal = appendStepOutput(journal, 'install', outcome.output);
    if (!outcome.ok) throw new Error(outcome.reason || `${path.basename(file)} failed`);
    return outcome.output;
  }

  async function runNpmGlobalInstall(layout: NpmGlobalLayout, targetVersion: string): Promise<void> {
    const platform = dependencies.platform || process.platform;
    const installArgs = ['install', '--global', '--prefix', layout.stagePrefix, '--no-audit', '--no-fund', `glimmervoid@${targetVersion}`];
    if (platform === 'linux') installArgs.push(NODE_PTY_INSTALL_SCRIPT_FLAG);
    const throttled = lowPriorityCommand({ file: npmPath, args: installArgs, platform });
    await runInstallCommand(throttled.file, throttled.args, layout.updatePath, INSTALL_TIMEOUT_MS);
  }

  async function verifyStagedPackage(layout: NpmGlobalLayout, targetVersion: string): Promise<void> {
    const stagedBin = path.join(layout.stagedPackagePath, 'dist', 'bin', 'glimmervoid.js');
    const printedVersion = (await runInstallCommand(nodePath, [stagedBin, '--version'], layout.updatePath, VERIFY_TIMEOUT_MS)).trim();
    if (printedVersion !== targetVersion) {
      throw new Error(`staged-version-mismatch: expected ${targetVersion}, the staged build printed ${printedVersion || 'nothing'}`);
    }
    await runInstallCommand(nodePath, [stagedBin, 'doctor'], layout.updatePath, VERIFY_TIMEOUT_MS);
  }

  async function failAndCleanNpmGlobal(layout: NpmGlobalLayout, reason: string): Promise<UpdateApplyOutcome> {
    stagedDescriptor = null;
    await fsPromises.rm(layout.stagePrefix, { recursive: true, force: true });
    await publish(failRun(journal, { reason, now: clock() }), false);
    return refusal(reason, reason);
  }

  async function writeRestoreMarker(failedReversals: RenameOperation[]): Promise<void> {
    const restore = failedReversals.map((operation) => ({
      from: operation.artifact === 'node_modules' ? PREVIOUS_DEPENDENCIES_BACKUP_NAME : PREVIOUS_DIST_BACKUP_NAME,
      to: operation.artifact,
    }));
    await writeJsonAtomic(path.join(updatePath, RESTORE_MARKER_NAME), { restore }, { fsPromises, mkdir: true });
  }

  async function noteRestoreMarker(failedReversals: RenameOperation[]): Promise<string> {
    if (failedReversals.length === 0) return '';
    try {
      await writeRestoreMarker(failedReversals);
      return '';
    } catch (error) {
      return `; restore marker unwritten: ${errorText(error)}`;
    }
  }

  async function reverseRenames(reversals: RenameOperation[]): Promise<RenameOperation[]> {
    const failed: RenameOperation[] = [];
    for (const reversal of reversals) {
      try {
        await fsPromises.rename(reversal.from, reversal.to);
      } catch {
        failed.push(reversal);
      }
    }
    return failed;
  }

  async function failHandOff(reason: string, mergeMovedHead: boolean, mergedTo: string | null, sampledHead: string | null): Promise<void> {
    const refusedCleanupSteps: string[] = [];
    if (mergeMovedHead && mergedTo && sampledHead) {
      const restored = await dependencies.gitWorkspace.resetKeepTo({
        projectPath: dependencies.packageRoot,
        expectedHead: mergedTo,
        sha: sampledHead,
        timeoutMs: MERGE_COMMAND_TIMEOUT_MS,
        admissionTimeoutMs: HANDOFF_QUEUE_ADMISSION_TIMEOUT_MS,
      });
      if (restored.admissionRefused) refusedCleanupSteps.push('head reset');
    }
    const removed = await dependencies.gitWorkspace.removeWorktreeByPath({
      projectPath: dependencies.packageRoot,
      cause: 'update-apply',
      cwd: stagingPath,
      admissionTimeoutMs: HANDOFF_QUEUE_ADMISSION_TIMEOUT_MS,
    });
    if (removed.admissionRefused) refusedCleanupSteps.push('staging worktree removal');
    const cleanupNote = refusedCleanupSteps.length === 0
      ? ''
      : `; the git queue refused ${refusedCleanupSteps.join(' and ')}`;
    await publish(failRun(journal, { reason: `${reason}${cleanupNote}`, now: clock(), atHandOff: true }), false);
  }

  async function performNpmGlobalHandOff(descriptor: NpmGlobalStagedDescriptor): Promise<void> {
    const plan = planNpmGlobalHandOffRenames(descriptor.layout);
    try {
      await fsPromises.rm(descriptor.layout.previousPackagePath, { recursive: true, force: true });
      for (let renameIndex = 0; renameIndex < plan.renames.length; renameIndex += 1) {
        const rename = plan.renames[renameIndex];
        try {
          await fsPromises.rename(rename.from, rename.to);
        } catch (error) {
          const failedReversals = await reverseRenames(plan.reversalsByFailureIndex[renameIndex] || []);
          const reversalNote = failedReversals.length === 0
            ? ''
            : `; could not move ${failedReversals.map((reversal) => reversal.from).join(', ')} back`;
          await publish(failRun(journal, { reason: `handoff-rename-failed: ${errorText(error)}${reversalNote}`, now: clock(), atHandOff: true }), false);
          return;
        }
      }
      hasSwappedNpmGlobalPackage = true;
      await publish(markSucceeded(journal, { now: clock() }), false);
      stagedDescriptor = null;
    } catch (error) {
      await publish(failRun(journal, { reason: errorText(error), now: clock(), atHandOff: true }), false);
    }
  }

  async function isPathPresent(candidatePath: string): Promise<boolean> {
    try {
      await fsPromises.access(candidatePath);
      return true;
    } catch {
      return false;
    }
  }

  function awaitSuccessorFate(successor: SuccessorProcess, previousPackagePath: string): Promise<SuccessorFate> {
    return new Promise((resolve) => {
      const deadline = clock() + SUCCESSOR_LISTEN_TIMEOUT_MS;
      let pollTimer: NodeJS.Timeout | null = null;
      let isSettled = false;
      const settle = (fate: SuccessorFate) => {
        if (isSettled) return;
        isSettled = true;
        if (pollTimer) clearTimeout(pollTimer);
        resolve(fate);
      };
      successor.once('exit', () => settle('exited'));
      const poll = async () => {
        if (isSettled) return;
        if (!await isPathPresent(previousPackagePath)) {
          settle('listening');
          return;
        }
        if (clock() >= deadline) {
          settle('still-starting');
          return;
        }
        pollTimer = setTimeout(() => { void poll(); }, SUCCESSOR_POLL_INTERVAL_MS);
      };
      void poll();
    });
  }

  async function restorePreviousPackage(layout: NpmGlobalLayout): Promise<string | null> {
    try {
      await fsPromises.rm(layout.quarantinedPackagePath, { recursive: true, force: true });
      await fsPromises.rename(layout.livePackagePath, layout.quarantinedPackagePath);
    } catch (error) {
      return errorText(error);
    }
    try {
      await fsPromises.rename(layout.previousPackagePath, layout.livePackagePath);
      return null;
    } catch (restoreError) {
      try {
        await fsPromises.rename(layout.quarantinedPackagePath, layout.livePackagePath);
        return errorText(restoreError);
      } catch (unquarantineError) {
        return `${errorText(restoreError)}; moving the new version back also failed: ${errorText(unquarantineError)}`;
      }
    }
  }

  async function superviseSuccessor(successor: SuccessorProcess): Promise<boolean> {
    if (!npmGlobalLayout || !hasSwappedNpmGlobalPackage) return false;
    const fate = await awaitSuccessorFate(successor, npmGlobalLayout.previousPackagePath);
    if (fate !== 'exited') return false;
    if (!await isPathPresent(npmGlobalLayout.previousPackagePath)) return false;
    const failedVersion = journal.toVersion || 'the new version';
    const rollbackFailure = await restorePreviousPackage(npmGlobalLayout);
    if (rollbackFailure) {
      await publish(failRun(journal, { reason: `${failedVersion} exited before listening and the rollback failed: ${rollbackFailure}`, now: clock(), atHandOff: true }), false);
      return false;
    }
    hasSwappedNpmGlobalPackage = false;
    dependencies.logger.warn(`[update] ${failedVersion} exited before listening; restored the previous version`);
    await publish(failRun(journal, { reason: `${failedVersion} exited before listening, so the previous version was restored`, now: clock(), atHandOff: true }), false);
    return true;
  }

  async function performHandOff(descriptor: CloneStagedDescriptor): Promise<void> {
    let mergeMovedHead = false;
    let sampledHead: string | null = null;
    try {
      const stagedHead = await gitCommand(['rev-parse', 'HEAD'], descriptor.stagingPath);
      if (!stagedHead.ok || stagedHead.output.trim() !== descriptor.targetSha) {
        await failHandOff('staging-head-mismatch', false, null, null);
        return;
      }
      const tree = await dependencies.gitWorkspace.probeWorktreeDirty({
        projectPath: dependencies.packageRoot,
        cwd: dependencies.packageRoot,
        admissionTimeoutMs: HANDOFF_QUEUE_ADMISSION_TIMEOUT_MS,
      });
      if (tree.admissionRefused) {
        await failHandOff('handoff-queue-admission-timed-out', false, null, null);
        return;
      }
      if (!tree.ok || tree.dirty || tree.headSha !== descriptor.fromSha) {
        await failHandOff('handoff-preflight-failed', false, null, tree.headSha);
        return;
      }
      const merged = await dependencies.gitWorkspace.mergeFastForwardTo({
        projectPath: dependencies.packageRoot,
        expectedHead: descriptor.fromSha,
        sha: descriptor.targetSha,
        admissionTimeoutMs: HANDOFF_QUEUE_ADMISSION_TIMEOUT_MS,
        timeoutMs: MERGE_COMMAND_TIMEOUT_MS,
      });
      if (!merged.ok) {
        await failHandOff(merged.err || merged.out || merged.outcome, false, null, merged.sampledHead);
        return;
      }
      mergeMovedHead = merged.sampledHead !== descriptor.targetSha;
      sampledHead = merged.sampledHead;
      const plan = planHandOffRenames({
        root: dependencies.packageRoot,
        stagingPath: descriptor.stagingPath,
        lockfileChanged: descriptor.lockfileChanged,
      });
      for (let renameIndex = 0; renameIndex < plan.renames.length; renameIndex += 1) {
        const rename = plan.renames[renameIndex];
        try {
          await fsPromises.rename(rename.from, rename.to);
        } catch (error) {
          const failedReversals = await reverseRenames(plan.reversalsByFailureIndex[renameIndex] || []);
          const markerNote = await noteRestoreMarker(failedReversals);
          await failHandOff(`handoff-rename-failed: ${errorText(error)}${markerNote}`, mergeMovedHead, descriptor.targetSha, sampledHead);
          return;
        }
      }
      await dependencies.gitWorkspace.removeWorktreeByPath({
        projectPath: dependencies.packageRoot,
        cause: 'update-apply',
        cwd: descriptor.stagingPath,
        admissionTimeoutMs: HANDOFF_QUEUE_ADMISSION_TIMEOUT_MS,
      });
      await publish(markSucceeded(journal, { now: clock() }), false);
      stagedDescriptor = null;
    } catch (error) {
      await failHandOff(errorText(error), mergeMovedHead, descriptor.targetSha, sampledHead);
    }
  }

  async function handOffStagedUpdate(): Promise<void> {
    await bootRun;
    const descriptor = stagedDescriptor;
    if (npmGlobalLayout) {
      await handOffNpmGlobalUpdate(npmGlobalLayout, descriptor);
      return;
    }
    if (descriptor?.kind !== 'clone' || inFlight) {
      await dependencies.gitWorkspace.removeWorktreeByPath({
        projectPath: dependencies.packageRoot,
        cause: 'update-apply',
        cwd: stagingPath,
        admissionTimeoutMs: HANDOFF_QUEUE_ADMISSION_TIMEOUT_MS,
      });
      return;
    }
    inFlight = true;
    const run = performHandOff(descriptor).finally(() => { inFlight = false; });
    activeRun = run;
    await run;
  }

  async function handOffNpmGlobalUpdate(layout: NpmGlobalLayout, descriptor: StagedDescriptor | null): Promise<void> {
    if (descriptor?.kind !== 'npm-global' || inFlight) {
      await fsPromises.rm(layout.stagePrefix, { recursive: true, force: true });
      return;
    }
    inFlight = true;
    const run = performNpmGlobalHandOff(descriptor).finally(() => { inFlight = false; });
    activeRun = run;
    await run;
  }

  function isRestartRequested(): boolean {
    return restartRequested;
  }

  function noteRestartRequested(): void {
    restartRequested = true;
  }

  async function readPersistedJournal(): Promise<PersistedJournalRead> {
    try {
      const parsedJson: unknown = JSON.parse(await fsPromises.readFile(dependencies.journalPath, 'utf8'));
      const parsed = UpdateJournalSchema.safeParse(parsedJson);
      if (parsed.success) return { journal: parsed.data, wasPersisted: true };
      return { journal: interruptedDisplayJournal(dependencies.getUpdateChannel(), 'update journal is invalid'), wasPersisted: false };
    } catch (error) {
      if (isMissingFileError(error, { includeNotDir: false })) return { journal: idleJournal(dependencies.getUpdateChannel()), wasPersisted: false };
      return { journal: interruptedDisplayJournal(dependencies.getUpdateChannel(), 'update journal could not be read'), wasPersisted: false };
    }
  }

  async function isStagingCheckoutPresent(): Promise<boolean> {
    try {
      await fsPromises.access(stagingPath);
      return true;
    } catch {
      return false;
    }
  }

  async function hasRestoreMarker(): Promise<boolean> {
    try {
      await fsPromises.readFile(path.join(updatePath, RESTORE_MARKER_NAME), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  async function cleanAfterListening(): Promise<void> {
    const persistedJournal = await readPersistedJournal();
    journal = persistedJournal.journal;
    const journalToDisplay = retireAtBoot(journal, { wasPersisted: persistedJournal.wasPersisted });
    if (journalToDisplay !== journal) await publish(journalToDisplay, false);
    const wasRunInFlight = journal.state === 'staged' || journal.state === 'running';
    if (journal.state === 'staged') {
      await publish(markDiscarded(journal, { reason: 'restarted without handoff', now: clock() }), false);
    }
    if (journal.state === 'running') {
      await publish(markInterrupted(journal, { reason: 'interrupted', now: clock() }), false);
    }
    if (npmGlobalLayout) {
      await fsPromises.rm(npmGlobalLayout.stagePrefix, { recursive: true, force: true });
      await fsPromises.rm(npmGlobalLayout.previousPackagePath, { recursive: true, force: true });
      await fsPromises.rm(npmGlobalLayout.quarantinedPackagePath, { recursive: true, force: true });
      return;
    }
    if (wasRunInFlight || await isStagingCheckoutPresent()) {
      await dependencies.gitWorkspace.removeWorktreeByPath({
        projectPath: dependencies.packageRoot,
        cause: 'update-apply',
        cwd: stagingPath,
      });
    }
    await fsPromises.rm(path.join(updatePath, QUARANTINED_DIST_NAME), { recursive: true, force: true });
    await fsPromises.rm(path.join(updatePath, QUARANTINED_DEPENDENCIES_NAME), { recursive: true, force: true });
    if (await hasRestoreMarker()) return;
    await fsPromises.rm(path.join(updatePath, PREVIOUS_DIST_BACKUP_NAME), { recursive: true, force: true });
    await fsPromises.rm(path.join(updatePath, PREVIOUS_DEPENDENCIES_BACKUP_NAME), { recursive: true, force: true });
  }

  function startAfterListening(httpServer: ListeningServer): void {
    const start = () => {
      pendingListeningServer = null;
      pendingListeningStart = null;
      bootRun = cleanAfterListening().catch((error) => {
        dependencies.logger.warn(`[update] boot cleanup failed: ${errorText(error)}`);
      });
    };
    if (httpServer.listening) {
      start();
      return;
    }
    pendingListeningServer = httpServer;
    pendingListeningStart = start;
    httpServer.once('listening', start);
  }

  async function whenIdle(): Promise<void> {
    await bootRun;
    await activeRun;
    await journalWriter.idle();
  }

  function stop(): Promise<void> {
    if (pendingListeningServer && pendingListeningStart) {
      pendingListeningServer.removeListener('listening', pendingListeningStart);
      pendingListeningServer = null;
      pendingListeningStart = null;
    }
    return whenIdle();
  }

  void refreshInstallWritability();

  return {
    applyUpdate,
    getJournal,
    getNpmGlobalInstall,
    handOffStagedUpdate,
    superviseSuccessor,
    isRestartRequested,
    noteRestartRequested,
    startAfterListening,
    stop,
    whenIdle,
  };
}

export { createUpdateApplyLane };
export type { UpdateApplyOutcome };
