import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { COHERENCE_CHECK_DETAIL_MAX_CHARS, COHERENCE_CHECK_STAGE_IDS, ProjectCoherenceCheckRequest } from '../../shared/contracts/coherence.ts';
import type { CoherenceCheckStage, CoherenceCheckStageId, ProjectCoherenceCheckResult } from '../../shared/contracts/coherence.ts';
import type { CoherenceHooksState } from '../../shared/contracts/session.ts';
import { errorMessage } from '../../shared/text.ts';
import { COHERENCE_ADOPT_NPM_FILE_MAX_BYTES } from './core/coherence-adopt-core.ts';
import {
  coherenceCheckStage, coherenceProbeSessionId, coherenceSessionStartCommand, decisionIdFromDecideOutput, describeCoherencePin, judgeCoherenceHooks,
  judgeCoherenceInstall, judgeCoherenceReading, judgeCoherenceSetting, judgeJournalReadBack, judgeLiveSessions, judgeNextAction, judgeSessionStartOutput,
  prerequisiteSkip, sessionStartPayload, summarizeCoherenceCheck,
} from './core/coherence-check-core.ts';
import type { CoherenceCheckOutcome } from './core/coherence-check-core.ts';
import { judgeCoherenceConfig } from './core/coherence-config-core.ts';
import type { CoherenceHost } from './core/coherence-session-core.ts';
import { firstLine } from '../core/text-core.ts';
import { checkGitEnvironment } from '../git/git-workspace.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import type { CoherenceNativeHooks } from './coherence-native-hooks.ts';
import type { CoherenceReadings } from './coherence-readings.ts';
import { createCoherenceRuntime } from './coherence-runtime.ts';
import {
  coherenceEnv, lstatOrNull, nodeModulesHolding, readCoherenceConfigEntry, readRegularFileNoFollow, snapshotCheckout, wasKilledByTimeout, withGuardrailsLaunch,
} from './coherence-sandboxed-run.ts';
import type { CheckoutSnapshot, GuardedCommand } from './coherence-sandboxed-run.ts';
import { createCoherenceSessionFeed } from './coherence-session-feed.ts';
import type { CoherenceFeedSession } from './coherence-session-feed.ts';

interface CoherenceCheckProject {
  id: string;
  path: string;
}

interface CoherenceCheckSession {
  name: string;
  path: string;
  hasLivePty: boolean;
  coherenceHooks: CoherenceHooksState | null;
}

interface CoherenceCheckOptions {
  listProjects: () => CoherenceCheckProject[];
  readSettings: () => { isSettingOn: boolean };
  readIntegrationTip: (projectPath: string) => Promise<string | null>;
  nativeHooks: Pick<CoherenceNativeHooks, 'prepare'>;
  readings: Pick<CoherenceReadings, 'readTrend'>;
  listLiveSessions: () => CoherenceCheckSession[];
  cliPath?: string | null;
  stepTimeoutMs?: number;
  budgetMs?: number;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}

type ReadySnapshot = Extract<CheckoutSnapshot, { ok: true }>;

type LinkedNodeModules = { ok: true; nodeModules: string } | { ok: false; outcome: CoherenceCheckOutcome };

interface CheckRun {
  project: CoherenceCheckProject;
  scratch: string;
  deadlineMs: number;
  env: Record<string, string>;
  tipSha: string | null;
  snapshot: ReadySnapshot | null;
  linkedNodeModules: LinkedNodeModules | null;
  probeSessionId: string | null;
  probeSession: CoherenceFeedSession | null;
}

const SETTINGS_READ_MAX_BYTES = 256 * 1024;
const PROBE_AGENT = 'glimmervoid-check';
const PROBE_REASON = 'the check proves the journal reaches the Glimmervoid feed';
const NO_CLI = 'the coherence CLI could not be resolved';
const NO_GUARDRAILS = 'the guardrails sandbox could not start';

async function readBoundedText(filePath: string, maxBytes: number): Promise<string | null> {
  const read = await readRegularFileNoFollow(filePath, { fromOffset: 0, maxBytes: maxBytes + 1 });
  if (read.kind !== 'read' || read.size > maxBytes) return null;
  return read.bytes.toString('utf8');
}

async function executableNodeModules(projectPath: string): Promise<string | null> {
  const nodeModules = await realpath(path.join(projectPath, 'node_modules')).catch(() => null);
  if (nodeModules === null) return null;
  const isHookTargetRunnable = await access(path.join(nodeModules, '.bin', 'coherence-hook'), fsConstants.X_OK).then(() => true, () => false);
  return isHookTargetRunnable ? nodeModules : null;
}

async function linkNodeModulesIntoSnapshot(projectPath: string, snapshot: ReadySnapshot): Promise<LinkedNodeModules> {
  const nodeModules = await executableNodeModules(projectPath);
  if (nodeModules === null) return { ok: false, outcome: { status: 'fail', detail: 'run npm install in the project first' } };
  const snapshotNodeModules = path.join(snapshot.cwd, 'node_modules');
  if (await lstatOrNull(snapshotNodeModules) !== null) return { ok: false, outcome: { status: 'fail', detail: 'the integration tip tracks node_modules' } };
  await symlink(nodeModules, snapshotNodeModules, 'dir');
  return { ok: true, nodeModules };
}

function exitFailure(what: string, error: unknown): CoherenceCheckOutcome {
  if (wasKilledByTimeout(error)) return { status: 'fail', detail: `${what} timed out` };
  const exitCode: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : null;
  const stderr: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'stderr') : null;
  const said = typeof stderr === 'string' && stderr.trim() !== '' ? `: ${firstLine(stderr.trim())}` : '';
  if (typeof exitCode === 'number') return { status: 'fail', detail: `${what} exited with code ${exitCode}${said}` };
  return { status: 'fail', detail: `${what} failed: ${firstLine(errorMessage(error))}` };
}

function createCoherenceCheck({
  listProjects, readSettings, readIntegrationTip, nativeHooks, readings, listLiveSessions, cliPath = createCoherenceRuntime().cliPath,
  stepTimeoutMs = 20_000, budgetMs = 90_000, now = Date.now, log = console,
}: CoherenceCheckOptions) {
  const inFlightByProject = new Map<string, Promise<ProjectCoherenceCheckResult>>();
  const feed = createCoherenceSessionFeed({ broadcastControl: () => {}, cliPath, timeoutMs: stepTimeoutMs, log });

  function remainingStepMs(run: CheckRun): number {
    return Math.max(1, Math.min(stepTimeoutMs, run.deadlineMs - now()));
  }

  async function inGuardrails<Outcome>(run: CheckRun, snapshot: ReadySnapshot, readablePaths: string[], use: (runGuarded: GuardedCommand) => Promise<Outcome>): Promise<Outcome | null> {
    const launchScratch = await mkdtemp(path.join(run.scratch, 'coherence-check-launch-'));
    return withGuardrailsLaunch({ scratch: launchScratch, snapshot, readablePaths, env: run.env }, use);
  }

  async function checkInstall(run: CheckRun): Promise<CoherenceCheckOutcome> {
    run.tipSha = await readIntegrationTip(run.project.path);
    if (run.tipSha === null) return { status: 'fail', detail: 'the project has no integration tip' };
    const snapshot = await snapshotCheckout({ cwd: run.project.path, snapshotRoot: path.join(run.scratch, 'snapshot'), env: run.env, source: { kind: 'commit', sha: run.tipSha } });
    if (!snapshot.ok) return { status: 'fail', detail: snapshot.failure === 'too-large' ? 'the integration tip is too large to snapshot' : 'the integration tip could not be snapshotted' };
    const verdict = judgeCoherenceConfig(await readCoherenceConfigEntry(snapshot.cwd));
    if (!verdict.ok) return { status: 'fail', detail: verdict.reason };
    run.snapshot = snapshot;
    const pinDescription = describeCoherencePin({
      packageText: await readBoundedText(path.join(snapshot.cwd, 'package.json'), COHERENCE_ADOPT_NPM_FILE_MAX_BYTES),
      lockfileText: await readBoundedText(path.join(snapshot.cwd, 'package-lock.json'), COHERENCE_ADOPT_NPM_FILE_MAX_BYTES),
    });
    return judgeCoherenceInstall({ tipSha: run.tipSha, pinDescription });
  }

  async function linkProjectNodeModules(run: CheckRun, snapshot: ReadySnapshot): Promise<LinkedNodeModules> {
    run.linkedNodeModules ??= await linkNodeModulesIntoSnapshot(run.project.path, snapshot);
    return run.linkedNodeModules;
  }

  async function checkHooks(run: CheckRun, snapshot: ReadySnapshot, host: CoherenceHost): Promise<CoherenceCheckOutcome> {
    const linked = await linkProjectNodeModules(run, snapshot);
    if (!linked.ok) return linked.outcome;
    const state = await nativeHooks.prepare({ root: snapshot.cwd, host, canWriteShims: false, checkCodexTrust: false });
    return judgeCoherenceHooks({ host, state });
  }

  async function checkSessionStart(run: CheckRun, snapshot: ReadySnapshot): Promise<CoherenceCheckOutcome> {
    const linked = await linkProjectNodeModules(run, snapshot);
    if (!linked.ok) return linked.outcome;
    const command = coherenceSessionStartCommand(await readBoundedText(path.join(snapshot.cwd, '.claude', 'settings.json'), SETTINGS_READ_MAX_BYTES));
    if (command === null) return { status: 'fail', detail: '.claude/settings.json declares no Coherence SessionStart hook' };
    const { nodeModules } = linked;
    const sessionId = coherenceProbeSessionId(randomBytes(6).toString('hex'));
    const readablePaths = [nodeModules, await realpath(process.execPath)];
    const ran = await inGuardrails(run, snapshot, readablePaths, async (runGuarded): Promise<CoherenceCheckOutcome> => {
      try {
        const stdout = await runGuarded('/bin/sh', ['-c', command], {
          timeoutMs: remainingStepMs(run), input: sessionStartPayload({ sessionId, cwd: snapshot.cwd }), extraEnv: { CLAUDE_PROJECT_DIR: snapshot.cwd },
        });
        return judgeSessionStartOutput(stdout, sessionId);
      } catch (error) {
        return exitFailure('the SessionStart hook', error);
      }
    });
    if (ran === null) return { status: 'fail', detail: NO_GUARDRAILS };
    if (ran.status === 'pass') run.probeSessionId = sessionId;
    return ran;
  }

  async function checkJournal(run: CheckRun, snapshot: ReadySnapshot, sessionId: string): Promise<CoherenceCheckOutcome> {
    if (!cliPath) return { status: 'fail', detail: NO_CLI };
    const probeText = `glimmervoid coherence check probe for ${sessionId}`;
    const readablePaths = [await nodeModulesHolding(cliPath), await realpath(process.execPath)];
    const decided = await inGuardrails(run, snapshot, readablePaths, async (runGuarded): Promise<{ stdout: string } | CoherenceCheckOutcome> => {
      try {
        return { stdout: await runGuarded(process.execPath, [cliPath, 'decide', probeText, '--because', PROBE_REASON, '--session', sessionId, '--agent', PROBE_AGENT], { timeoutMs: remainingStepMs(run) }) };
      } catch (error) {
        return exitFailure('coherence decide', error);
      }
    });
    if (decided === null) return { status: 'fail', detail: NO_GUARDRAILS };
    if (!('stdout' in decided)) return decided;
    const probeId = decisionIdFromDecideOutput(decided.stdout);
    if (probeId === null) return { status: 'fail', detail: 'coherence decide printed no decision id' };
    const probeSession: CoherenceFeedSession = {
      id: `coherence-check-${run.project.id}`, resumeSessionId: sessionId, baseSha: null, coherenceHooks: { active: true }, agentId: 'claude-code',
      effectiveCwd: () => snapshot.cwd, on: () => probeSession,
    };
    const journal = await feed.readJournal(probeSession);
    if (!journal.ok) return { status: 'fail', detail: journal.error };
    run.probeSession = probeSession;
    return judgeJournalReadBack({ probeId, probeText, entries: journal.entries });
  }

  async function checkNextAction(run: CheckRun): Promise<CoherenceCheckOutcome> {
    if (run.probeSession === null) return { status: 'fail', detail: 'the journal probe left no session to regulate' };
    return judgeNextAction(await feed.readNextAction(run.probeSession));
  }

  async function checkReadings(run: CheckRun): Promise<CoherenceCheckOutcome> {
    if (run.tipSha === null) return { status: 'fail', detail: 'the project has no integration tip' };
    return judgeCoherenceReading({ trend: await readings.readTrend(run.project), tipSha: run.tipSha, nowMs: now() });
  }

  async function checkLiveSessions(run: CheckRun): Promise<CoherenceCheckOutcome> {
    const projectPath = await realpath(run.project.path);
    const live = listLiveSessions().filter((session) => session.hasLivePty);
    const ofProject: CoherenceCheckSession[] = [];
    for (const session of live) {
      if (await realpath(session.path).catch(() => path.resolve(session.path)) === projectPath) ofProject.push(session);
    }
    return judgeLiveSessions(ofProject);
  }

  function snapshotOrFailure(run: CheckRun, check: (snapshot: ReadySnapshot) => Promise<CoherenceCheckOutcome>): Promise<CoherenceCheckOutcome> {
    if (run.snapshot === null) return Promise.resolve({ status: 'fail', detail: 'the integration tip was not snapshotted' });
    return check(run.snapshot);
  }

  function checkJournalOfProbe(run: CheckRun): Promise<CoherenceCheckOutcome> {
    const probeSessionId = run.probeSessionId;
    if (probeSessionId === null) return Promise.resolve({ status: 'fail', detail: 'the SessionStart probe left no session id' });
    return snapshotOrFailure(run, (snapshot) => checkJournal(run, snapshot, probeSessionId));
  }

  const stageChecks: Readonly<Record<CoherenceCheckStageId, (run: CheckRun) => Promise<CoherenceCheckOutcome>>> = {
    setting: () => Promise.resolve(judgeCoherenceSetting(readSettings())),
    install: checkInstall,
    'hooks-claude': (run) => snapshotOrFailure(run, (snapshot) => checkHooks(run, snapshot, 'claude')),
    'hooks-codex': (run) => snapshotOrFailure(run, (snapshot) => checkHooks(run, snapshot, 'codex')),
    'session-start': (run) => snapshotOrFailure(run, (snapshot) => checkSessionStart(run, snapshot)),
    journal: checkJournalOfProbe,
    'next-action': checkNextAction,
    readings: checkReadings,
    'live-sessions': checkLiveSessions,
  };

  async function runStage(id: CoherenceCheckStageId, run: CheckRun, finishedStages: readonly CoherenceCheckStage[]): Promise<CoherenceCheckStage> {
    const skipped = prerequisiteSkip(id, finishedStages);
    if (skipped) return skipped;
    if (now() > run.deadlineMs) return coherenceCheckStage(id, { status: 'fail', detail: `the check ran past its ${Math.round(budgetMs / 1000)} s budget` });
    try {
      return coherenceCheckStage(id, await stageChecks[id](run));
    } catch (error) {
      log.warn(`[coherence-check] ${id} failed for ${run.project.id}: ${firstLine(errorMessage(error))}`);
      return coherenceCheckStage(id, { status: 'fail', detail: firstLine(errorMessage(error)) });
    }
  }

  async function checkProject(project: CoherenceCheckProject): Promise<ProjectCoherenceCheckResult> {
    const deadlineMs = now() + budgetMs;
    const scratch = await makeHostScratchDirectory('coherence-check-');
    const stages: CoherenceCheckStage[] = [];
    try {
      const run: CheckRun = { project, scratch, deadlineMs, env: coherenceEnv(await checkGitEnvironment(project.path)), tipSha: null, snapshot: null, linkedNodeModules: null, probeSessionId: null, probeSession: null };
      for (const id of COHERENCE_CHECK_STAGE_IDS) stages.push(await runStage(id, run, stages));
      return summarizeCoherenceCheck(project.id, stages);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  function check(request: unknown): Promise<ProjectCoherenceCheckResult> {
    const parsed = ProjectCoherenceCheckRequest.safeParse(request);
    if (!parsed.success) return Promise.resolve({ projectId: '', ok: false, stages: [], error: 'invalid request' });
    const { projectId } = parsed.data;
    const project = listProjects().find((candidate) => candidate.id === projectId);
    if (!project) return Promise.resolve({ projectId, ok: false, stages: [], error: 'unknown project' });
    const running = inFlightByProject.get(projectId);
    if (running) return running;
    const started = checkProject(project)
      .catch((error: unknown): ProjectCoherenceCheckResult => ({ projectId, ok: false, stages: [], error: firstLine(errorMessage(error)).slice(0, COHERENCE_CHECK_DETAIL_MAX_CHARS) || 'the check failed' }))
      .finally(() => inFlightByProject.delete(projectId));
    inFlightByProject.set(projectId, started);
    return started;
  }

  return { check };
}

type CoherenceCheck = ReturnType<typeof createCoherenceCheck>;

export { createCoherenceCheck };
export type { CoherenceCheck };
