import { checkCommand } from 'cc-safety-net/api';
import type { ParentLink } from '../../shared/contracts/session.ts';
import { ownerIdOf } from '../../shared/parent-link.ts';
import { execFile, spawn } from '../child-process-safe.ts';
import { buildAllowlistedChildEnv } from '../git/core/git-invocation-core.ts';
import { decideStandardsGate } from '../../session/core/merge-gate.ts';
import type { StandardsGateVerdict } from '../../session/core/merge-gate.ts';
import { AGENT_DONE_CHECK_ID_PREFIX, PANEL_MIN_CHANGED_LINES, VERIFICATION_OUTPUT_TAIL_BYTES, agentDoneCheckIdOf, VerificationSettings as VerificationSettingsSchema } from '../../shared/contracts/verification.ts';
import type { CheckOutcome, VerificationRun, VerificationSettings } from '../../shared/contracts/verification.ts';
import { contestantDiffStats } from '../race/race-diff.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import { clock } from '../../shared/clock.ts';
import { selfLaunch } from '../runtime-paths.ts';
import { classifyHeavyCommand } from '../spawn-gate.ts';
import type { HeavyCommandGate } from '../spawn-gate.ts';
import { errorMessage } from '../../shared/text.ts';
import { launchArgvFor, overallStatus, parseCheckCommand, readVerificationSettings, redactSecretLines, settingsFingerprint } from './core/verification-core.ts';

const SECRET_ENV_NAME_PATTERN = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i;
const UNREAD_TREE_SKIP_REASON = 'the worktree could not be read at turn end, so the checks did not run for this turn';
const SETTINGS_WITHOUT_CHECKS = VerificationSettingsSchema.parse({});
const INVALID_CONFIG_CHECK_ID = 'verification-config';
const SANDBOX_SKIP_REASON = 'checks do not run while sessionSandbox is on, because they would run agent-edited code outside the sandbox';

interface WorktreeTree {
  sig: string;
  dirty: boolean;
  headSha: string | null;
}

interface VerifiableSession {
  id: string;
  path: string;
  ephemeral: boolean;
  parent?: ParentLink | null;
  agentDoneLines: readonly { text: string; command: string }[];
  hasOwnWorktree: boolean;
  worktreeDir: string | null;
  on(event: 'post-turn-check', listener: () => void): unknown;
  worktreeLifecycle: {
    computeGateTree(): Promise<WorktreeTree | null>;
    snapshot(): { baseSha: string | null; effectiveBase: string | null };
    setMergeGate(gate: ((tree: WorktreeTree | null) => Promise<StandardsGateVerdict>) | null): void;
  };
}

interface BuiltInChecks {
  outcomesOf(session: VerifiableSession, commitSha: string | null): Promise<CheckOutcome[]>;
  requiredIdsOf(session: VerifiableSession): Promise<string[]>;
  freshnessOf(session: VerifiableSession): string;
}

const NO_BUILT_IN_CHECKS: BuiltInChecks = { outcomesOf: async () => [], requiredIdsOf: async () => [], freshnessOf: () => '' };

interface VerificationWiringDependencies {
  getVerificationConfig: () => unknown;
  builtInChecks?: BuiltInChecks;
  isSessionSandboxOn: () => boolean;
  broadcastControl: (message: ControlMessageRecord) => void;
  heavyCommandGate?: HeavyCommandGate;
  testConcurrency?: number | null;
  logger: Pick<Console, 'warn'>;
  platform?: string;
}

type CheckNowOutcome = { ok: true; run: VerificationRun | null } | { ok: false; reason: string };

interface VerificationWiring {
  attachSession(session: VerifiableSession): void;
  latestRun(sessionId: string): VerificationRun | null;
  checkNow(sessionId: string, waitLimitMs: number): Promise<CheckNowOutcome>;
  forgetSession(sessionId: string): void;
  stop(): void;
}

interface AgentCheck {
  id: string;
  command: string;
}

interface CachedRun {
  key: string;
  run: VerificationRun;
}

interface CheckProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  launchError: string | null;
  outputTail: string;
}

function secretEnvValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV_NAME_PATTERN.test(name) && typeof value === 'string')
    .map(([, value]) => value ?? '');
}

function killCheckTree(pid: number | undefined, platform: string): void {
  if (pid === undefined) return;
  if (platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function runCheckProcess(program: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number, platform: string, liveCheckPids: Set<number>): Promise<CheckProcessResult> {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    let isSettled = false;
    const settle = (result: CheckProcessResult) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      if (child.pid !== undefined) liveCheckPids.delete(child.pid);
      resolve(result);
    };
    const keepTail = (chunk: Buffer) => {
      const joined = Buffer.concat([tail, chunk]);
      tail = joined.length > VERIFICATION_OUTPUT_TAIL_BYTES ? joined.subarray(joined.length - VERIFICATION_OUTPUT_TAIL_BYTES) : joined;
    };
    const child = spawn(program, args, { cwd, env, windowsHide: true, detached: platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid !== undefined) liveCheckPids.add(child.pid);
    const timer = setTimeout(() => {
      killCheckTree(child.pid, platform);
      settle({ exitCode: null, timedOut: true, launchError: null, outputTail: tail.toString('utf8') });
    }, timeoutMs);
    child.stdout?.on('data', keepTail);
    child.stderr?.on('data', keepTail);
    child.on('error', (error) => {
      settle({ exitCode: null, timedOut: false, launchError: errorMessage(error), outputTail: '' });
    });
    child.on('close', (exitCode) => {
      settle({ exitCode, timedOut: false, launchError: null, outputTail: tail.toString('utf8') });
    });
  });
}

function statusOf(result: CheckProcessResult): CheckOutcome['status'] {
  if (result.timedOut) return 'timeout';
  if (result.launchError === null && result.exitCode === 0) return 'pass';
  return 'fail';
}

const GLIMMERVOID_PROGRAM = 'glimmervoid';

function createVerificationWiring(dependencies: VerificationWiringDependencies): VerificationWiring {
  const platform = dependencies.platform ?? process.platform;
  const builtInChecks = dependencies.builtInChecks ?? NO_BUILT_IN_CHECKS;
  const cachedRunBySession = new Map<string, CachedRun>();
  const inFlightBySession = new Map<string, { key: string; promise: Promise<VerificationRun> }>();
  const publishedRunBySession = new Map<string, VerificationRun>();
  const turnEndCountBySession = new Map<string, number>();
  const turnEndCountOf = (sessionId: string) => turnEndCountBySession.get(sessionId) ?? 0;
  const warnedInvalidRepos = new Set<string>();
  const liveCheckPidsBySession = new Map<string, Set<number>>();
  const attachedSessionIds = new Set<string>();
  const attachedSessionById = new Map<string, VerifiableSession>();
  const sessionAbortById = new Map<string, AbortController>();
  const stopController = new AbortController();
  const panelSessionIds = new Set<string>();
  const invalidConfigMessageBySession = new Map<string, string | null>();

  function liveCheckPidsOf(sessionId: string): Set<number> {
    const existing = liveCheckPidsBySession.get(sessionId);
    if (existing) return existing;
    const created = new Set<number>();
    liveCheckPidsBySession.set(sessionId, created);
    return created;
  }

  function killChecksOf(sessionId: string): void {
    for (const pid of liveCheckPidsBySession.get(sessionId) ?? []) killCheckTree(pid, platform);
    liveCheckPidsBySession.delete(sessionId);
  }

  function publish(finishedOrRunning: VerificationRun): void {
    if (!panelSessionIds.has(finishedOrRunning.sessionId)) return;
    const invalidConfigMessage = invalidConfigMessageBySession.get(finishedOrRunning.sessionId) ?? null;
    const run = invalidConfigMessage === null || finishedOrRunning.status === 'running' ? finishedOrRunning : withInvalidConfigCheck(finishedOrRunning, invalidConfigMessage);
    publishedRunBySession.set(run.sessionId, run);
    dependencies.broadcastControl({ type: 'verification-run', id: run.sessionId, run });
  }

  function skippedOutcome(spec: { id: string; command: string }, reason: string): CheckOutcome {
    return { id: spec.id, command: spec.command, status: 'skipped', exitCode: null, outputTail: reason };
  }

const NODE_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '-e', '--eval', '-p', '--print', '-C', '--conditions', '--env-file', '--test-name-pattern', '--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-timeout']);

function withTestConcurrencyArg(argv: readonly string[], testConcurrency: number | null): string[] {
  if (testConcurrency === null || !Number.isInteger(testConcurrency) || testConcurrency < 1) return [...argv];
  const isNodeBinary = /(?:^|[\\/])node(?:\.exe)?$/i.test(argv[0] ?? '');
  if (!isNodeBinary) return [...argv];
  let testFlagIndex = -1;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (token === '--') break;
    if (!token.startsWith('-')) break;
    if (token === '--test-concurrency' || token.startsWith('--test-concurrency=')) return [...argv];
    if (token === '--test') testFlagIndex = index;
    if (NODE_VALUE_FLAGS.has(token)) index += 1;
  }
  if (testFlagIndex === -1) return [...argv];
  return [...argv.slice(0, testFlagIndex + 1), `--test-concurrency=${testConcurrency}`, ...argv.slice(testFlagIndex + 1)];
}

  async function runCheck(sessionId: string, worktreeDir: string, spec: { id: string; command: string }, timeoutMs: number): Promise<CheckOutcome> {
    if (dependencies.isSessionSandboxOn()) return skippedOutcome(spec, SANDBOX_SKIP_REASON);
    const parsedArgv = parseCheckCommand(spec.command);
    if (!parsedArgv) return skippedOutcome(spec, 'the command uses shell syntax, so it was not run; give a plain program and arguments');
    const baseArgv = parsedArgv[0] === GLIMMERVOID_PROGRAM ? [...selfLaunch('cli'), ...parsedArgv.slice(1)] : parsedArgv;
    const testConcurrency = dependencies.testConcurrency ?? null;
    const argv = withTestConcurrencyArg(baseArgv, testConcurrency);
    const env = buildAllowlistedChildEnv(process.env, platform);
    const { program, args } = launchArgvFor(argv, platform, env.ComSpec ?? env.COMSPEC ?? 'cmd.exe');
    const sessionController = sessionAbortById.get(sessionId);
    const waitSignal = sessionController
      ? AbortSignal.any([stopController.signal, sessionController.signal])
      : stopController.signal;
    const acquired = dependencies.heavyCommandGate
      ? await dependencies.heavyCommandGate.acquire({ sessionId, commandClass: classifyHeavyCommand(spec.command) ?? 'test', signal: waitSignal })
      : null;
    if (acquired && acquired.status !== 'granted') return skippedOutcome(spec, 'the verification check was cancelled while waiting for a build slot');
    try {
      if (stopController.signal.aborted || !attachedSessionIds.has(sessionId)) {
        return skippedOutcome(spec, 'the verification check was cancelled before starting');
      }
      const result = await runCheckProcess(program, args, worktreeDir, env, timeoutMs, platform, liveCheckPidsOf(sessionId));
      const output = result.launchError ?? result.outputTail;
      return { id: spec.id, command: spec.command, status: statusOf(result), exitCode: result.exitCode, outputTail: redactSecretLines(output, secretEnvValues()) };
    } finally {
      if (acquired?.status === 'granted') dependencies.heavyCommandGate?.release(acquired.lease.id);
    }
  }

  function runAgentCheck(sessionId: string, worktreeDir: string, agentCheck: AgentCheck, timeoutMs: number): Promise<CheckOutcome> {
    const screened = checkCommand({ command: agentCheck.command, cwd: worktreeDir });
    if (screened.kind === 'deny') return Promise.resolve({ id: agentCheck.id, command: agentCheck.command, status: 'fail', exitCode: null, outputTail: `Sane YOLO refused to run it: ${screened.reason}` });
    return runCheck(sessionId, worktreeDir, agentCheck, timeoutMs);
  }

  function agentChecksOf(session: VerifiableSession): AgentCheck[] {
    return session.agentDoneLines.map((line, index) => ({ id: agentDoneCheckIdOf(index), command: line.command }));
  }

  async function runChecks(session: VerifiableSession, settings: VerificationSettings, agentChecks: readonly AgentCheck[], key: string, sig: string): Promise<VerificationRun> {
    const worktreeDir = session.worktreeDir;
    const turnEndCountAtStart = turnEndCountOf(session.id);
    publish({ sessionId: session.id, sig, status: 'running', checks: [], finishedAt: null });
    const checks: CheckOutcome[] = await builtInChecks.outcomesOf(session, null).catch((error: unknown) => {
      dependencies.logger.warn(`[verification] ${session.id}: the built-in checks did not run: ${errorMessage(error)}`);
      return [];
    });
    for (const spec of settings.checks) {
      if (!attachedSessionIds.has(session.id)) break;
      checks.push(worktreeDir ? await runCheck(session.id, worktreeDir, spec, settings.timeoutSeconds * 1000) : skippedOutcome(spec, 'the session has no worktree'));
    }
    for (const agentCheck of agentChecks) {
      if (!attachedSessionIds.has(session.id)) break;
      checks.push(worktreeDir ? await runAgentCheck(session.id, worktreeDir, agentCheck, settings.timeoutSeconds * 1000) : skippedOutcome(agentCheck, 'the session has no worktree'));
    }
    const run: VerificationRun = { sessionId: session.id, sig, status: overallStatus(checks.filter((check) => !check.id.startsWith(AGENT_DONE_CHECK_ID_PREFIX))), checks, finishedAt: clock.nowMs() };
    if (!attachedSessionIds.has(session.id)) return run;
    cachedRunBySession.set(session.id, { key, run });
    if (turnEndCountOf(session.id) === turnEndCountAtStart) publish(run);
    return run;
  }

  function runKeyOf(session: VerifiableSession, settings: VerificationSettings, sig: string): string {
    return `${sig}\0${settingsFingerprint(settings)}\0${JSON.stringify(agentChecksOf(session))}\0${builtInChecks.freshnessOf(session)}`;
  }

  function ensureRun(session: VerifiableSession, settings: VerificationSettings, sig: string, { reuseFailed }: { reuseFailed: boolean }): Promise<VerificationRun> {
    const agentChecks = agentChecksOf(session);
    const key = runKeyOf(session, settings, sig);
    const cached = cachedRunBySession.get(session.id);
    if (cached?.key === key && (reuseFailed || cached.run.status === 'passed')) return Promise.resolve(cached.run);
    const inFlight = inFlightBySession.get(session.id);
    if (inFlight?.key === key) return inFlight.promise;
    const waitForCurrent = inFlight ? inFlight.promise.catch(() => null) : Promise.resolve(null);
    const promise: Promise<VerificationRun> = waitForCurrent
      .then(() => runChecks(session, settings, agentChecks, key, sig))
      .finally(() => {
        if (inFlightBySession.get(session.id)?.promise === promise) inFlightBySession.delete(session.id);
      });
    inFlightBySession.set(session.id, { key, promise });
    return promise;
  }

  function lookupSettings(session: VerifiableSession) {
    const lookup = readVerificationSettings(dependencies.getVerificationConfig(), session.path);
    if (lookup.kind === 'invalid' && !warnedInvalidRepos.has(session.path)) {
      warnedInvalidRepos.add(session.path);
      dependencies.logger.warn(`[verification] the entry for ${session.path} is invalid, so its checks do not run and merges are refused: ${lookup.message}`);
    }
    return lookup;
  }

  function publishUnreadTree(settings: VerificationSettings, sessionId: string): void {
    const checks = settings.checks.map((spec) => skippedOutcome(spec, UNREAD_TREE_SKIP_REASON));
    publish({ sessionId, sig: '', status: overallStatus(checks), checks, finishedAt: clock.nowMs() });
  }

  function withInvalidConfigCheck(run: VerificationRun, message: string): VerificationRun {
    const invalidConfig: CheckOutcome = { id: INVALID_CONFIG_CHECK_ID, command: 'config.json verification.repos', status: 'fail', exitCode: null, outputTail: `this repository's verification entry is invalid, so its checks did not run and merges are refused: ${message}` };
    return { ...run, status: 'failed', checks: [invalidConfig, ...run.checks] };
  }

  async function verifyAtTurnEnd(session: VerifiableSession): Promise<void> {
    if (!session.hasOwnWorktree) return;
    const lookup = lookupSettings(session);
    const settings = lookup.kind === 'ok' ? lookup.settings : SETTINGS_WITHOUT_CHECKS;
    invalidConfigMessageBySession.set(session.id, lookup.kind === 'invalid' ? lookup.message : null);
    const turnEndCount = turnEndCountOf(session.id) + 1;
    turnEndCountBySession.set(session.id, turnEndCount);
    const isLatestTurnEnd = () => turnEndCountOf(session.id) === turnEndCount && attachedSessionIds.has(session.id);
    const tree = await session.worktreeLifecycle.computeGateTree();
    if (!tree) {
      if (isLatestTurnEnd()) publishUnreadTree(settings, session.id);
      return;
    }
    if (!panelSessionIds.has(session.id) && await isBelowPanelChangedLines(session)) return;
    panelSessionIds.add(session.id);
    const run = await ensureRun(session, settings, tree.sig, { reuseFailed: true });
    if (isLatestTurnEnd()) publish(run);
  }

  async function isBelowPanelChangedLines(session: VerifiableSession): Promise<boolean> {
    if (!session.worktreeDir) return false;
    const { baseSha, effectiveBase } = session.worktreeLifecycle.snapshot();
    const startSha = baseSha ?? effectiveBase;
    if (!startSha) return false;
    const diffStats = await contestantDiffStats({ worktreeDir: session.worktreeDir, startSha });
    if (!diffStats.ok) return false;
    return diffStats.stats.linesAdded + diffStats.stats.linesRemoved < PANEL_MIN_CHANGED_LINES;
  }

  async function checkNow(sessionId: string, waitLimitMs: number): Promise<CheckNowOutcome> {
    const session = attachedSessionById.get(sessionId);
    if (!session?.hasOwnWorktree) return { ok: false, reason: 'this session has no worktree of its own, so there is nothing to check' };
    const lookup = lookupSettings(session);
    const settings = lookup.kind === 'ok' ? lookup.settings : SETTINGS_WITHOUT_CHECKS;
    const tree = await session.worktreeLifecycle.computeGateTree();
    if (!tree) return { ok: false, reason: 'the worktree could not be read, so the checks did not run' };
    const finishedRun = ensureRun(session, settings, tree.sig, { reuseFailed: true });
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const waitLimit = new Promise<null>((resolve) => { waitTimer = setTimeout(() => resolve(null), waitLimitMs); });
    const run = await Promise.race([finishedRun, waitLimit]).finally(() => clearTimeout(waitTimer));
    if (run === null || lookup.kind !== 'invalid') return { ok: true, run };
    return { ok: true, run: withInvalidConfigCheck(run, lookup.message) };
  }

  async function gateMerge(session: VerifiableSession, tree: WorktreeTree | null): Promise<StandardsGateVerdict> {
    const lookup = lookupSettings(session);
    if (lookup.kind === 'invalid') return { allowed: false, reason: `the verification entry for this repository in config.json is invalid: ${lookup.message}` };
    const isConfigGateOn = lookup.kind === 'ok' && lookup.settings.gate.enabled;
    const settings = lookup.kind === 'ok' ? lookup.settings : SETTINGS_WITHOUT_CHECKS;
    const configRequiredIds = isConfigGateOn ? settings.gate.required ?? settings.checks.map((check) => check.id) : [];
    const builtInRequiredIds = await builtInChecks.requiredIdsOf(session);
    const requiredCheckIds = [...configRequiredIds, ...builtInRequiredIds];
    if (requiredCheckIds.length === 0) return { allowed: true };
    const isTreeLandable = tree !== null && !tree.dirty;
    const run = isTreeLandable ? await landingRunOf(session, settings, tree, isConfigGateOn, builtInRequiredIds.length > 0) : null;
    return decideStandardsGate({
      enabled: true,
      requiredCheckIds,
      run,
      currentSig: tree?.sig ?? null,
      isTreeDirty: tree?.dirty === true,
    });
  }

  async function landingRunOf(session: VerifiableSession, settings: VerificationSettings, tree: WorktreeTree, isConfigGateOn: boolean, isBuiltInGateOn: boolean): Promise<VerificationRun> {
    const configRun = isConfigGateOn ? await ensureRun(session, settings, tree.sig, { reuseFailed: false }) : null;
    const builtInOutcomes = isBuiltInGateOn ? await builtInChecks.outcomesOf(session, tree.headSha) : [];
    const builtInIds = new Set(builtInOutcomes.map((check) => check.id));
    const checks = [...builtInOutcomes, ...(configRun?.checks ?? []).filter((check) => !builtInIds.has(check.id))];
    return { sessionId: session.id, sig: tree.sig, status: overallStatus(checks.filter((check) => !check.id.startsWith(AGENT_DONE_CHECK_ID_PREFIX))), checks, finishedAt: clock.nowMs() };
  }


  function attachSession(session: VerifiableSession): void {
    attachedSessionIds.add(session.id);
    attachedSessionById.set(session.id, session);
    sessionAbortById.set(session.id, new AbortController());
    session.worktreeLifecycle.setMergeGate((tree) => gateMerge(session, tree));
    if (session.ephemeral && ownerIdOf(session.parent) === null) return;
    session.on('post-turn-check', () => {
      verifyAtTurnEnd(session).catch((error: unknown) => {
        dependencies.logger.warn(`[verification] ${session.id}: ${errorMessage(error)}`);
      });
    });
  }

  return {
    attachSession,
    checkNow,
    latestRun: (sessionId) => publishedRunBySession.get(sessionId) ?? cachedRunBySession.get(sessionId)?.run ?? null,
    forgetSession: (sessionId) => {
      attachedSessionIds.delete(sessionId);
      attachedSessionById.delete(sessionId);
      sessionAbortById.get(sessionId)?.abort();
      sessionAbortById.delete(sessionId);
      panelSessionIds.delete(sessionId);
      killChecksOf(sessionId);
      cachedRunBySession.delete(sessionId);
      publishedRunBySession.delete(sessionId);
      turnEndCountBySession.delete(sessionId);
      invalidConfigMessageBySession.delete(sessionId);
      inFlightBySession.delete(sessionId);
    },
    stop: () => {
      stopController.abort();
      for (const controller of sessionAbortById.values()) controller.abort();
      sessionAbortById.clear();
      for (const sessionId of [...liveCheckPidsBySession.keys()]) killChecksOf(sessionId);
    },
  };
}

export { createVerificationWiring };
export type { VerificationWiring };
