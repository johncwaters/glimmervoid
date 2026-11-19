import { execFile, spawn } from '../child-process-safe.ts';
import { buildAllowlistedChildEnv } from '../git/core/git-invocation-core.ts';
import { decideStandardsGate } from '../../session/core/merge-gate.ts';
import type { StandardsGateVerdict } from '../../session/core/merge-gate.ts';
import { AGENT_COMMAND_WAITING_REASON, AGENT_DONE_CHECK_ID_PREFIX, VERIFICATION_OUTPUT_TAIL_BYTES, VerificationSettings as VerificationSettingsSchema } from '../../shared/contracts/verification.ts';
import type { CheckOutcome, RemovedTestLine, VerificationRun, VerificationSettings } from '../../shared/contracts/verification.ts';
import { streamRemovedTestLines } from './test-keeping-scan.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import { clock } from '../../shared/clock.ts';
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
}

interface VerifiableSession {
  id: string;
  path: string;
  ephemeral: boolean;
  ownerId?: string | null;
  agentDoneLines: readonly { text: string; command?: string }[];
  allowedDoneCommands: readonly string[];
  hasOwnWorktree: boolean;
  worktreeDir: string | null;
  on(event: 'post-turn-check', listener: () => void): unknown;
  worktreeLifecycle: {
    computeGateTree(): Promise<WorktreeTree | null>;
    snapshot(): { baseSha: string | null; effectiveBase: string | null };
    setMergeGate(gate: ((tree: WorktreeTree | null) => Promise<StandardsGateVerdict>) | null): void;
  };
}

interface VerificationWiringDependencies {
  getVerificationConfig: () => unknown;
  isSessionSandboxOn: () => boolean;
  broadcastControl: (message: ControlMessageRecord) => void;
  logger: Pick<Console, 'warn'>;
  platform?: string;
}

interface VerificationWiring {
  attachSession(session: VerifiableSession): void;
  runAllowedAgentCommands(session: VerifiableSession): void;
  latestRun(sessionId: string): VerificationRun | null;
  forgetSession(sessionId: string): void;
  stop(): void;
}

interface AgentCheck {
  id: string;
  command: string;
  isAllowed: boolean;
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

function createVerificationWiring(dependencies: VerificationWiringDependencies): VerificationWiring {
  const platform = dependencies.platform ?? process.platform;
  const cachedRunBySession = new Map<string, CachedRun>();
  const inFlightBySession = new Map<string, { key: string; promise: Promise<VerificationRun> }>();
  const publishedRunBySession = new Map<string, VerificationRun>();
  const turnEndCountBySession = new Map<string, number>();
  const turnEndCountOf = (sessionId: string) => turnEndCountBySession.get(sessionId) ?? 0;
  const warnedInvalidRepos = new Set<string>();
  const liveCheckPidsBySession = new Map<string, Set<number>>();
  const attachedSessionIds = new Set<string>();
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
    const invalidConfigMessage = invalidConfigMessageBySession.get(finishedOrRunning.sessionId) ?? null;
    const run = invalidConfigMessage === null || finishedOrRunning.status === 'running' ? finishedOrRunning : withInvalidConfigCheck(finishedOrRunning, invalidConfigMessage);
    publishedRunBySession.set(run.sessionId, run);
    dependencies.broadcastControl({ type: 'verification-run', id: run.sessionId, run });
  }

  function skippedOutcome(spec: { id: string; command: string }, reason: string): CheckOutcome {
    return { id: spec.id, command: spec.command, status: 'skipped', exitCode: null, outputTail: reason };
  }

  async function runCheck(sessionId: string, worktreeDir: string, spec: { id: string; command: string }, timeoutMs: number): Promise<CheckOutcome> {
    if (dependencies.isSessionSandboxOn()) return skippedOutcome(spec, SANDBOX_SKIP_REASON);
    const argv = parseCheckCommand(spec.command);
    if (!argv) return skippedOutcome(spec, 'the command uses shell syntax, so it was not run; give a plain program and arguments');
    const env = buildAllowlistedChildEnv(process.env, platform);
    const { program, args } = launchArgvFor(argv, platform, env.ComSpec ?? env.COMSPEC ?? 'cmd.exe');
    const result = await runCheckProcess(program, args, worktreeDir, env, timeoutMs, platform, liveCheckPidsOf(sessionId));
    const output = result.launchError ?? result.outputTail;
    return { id: spec.id, command: spec.command, status: statusOf(result), exitCode: result.exitCode, outputTail: redactSecretLines(output, secretEnvValues()) };
  }

  async function scanRemovedTestLines(session: VerifiableSession): Promise<RemovedTestLine[] | null> {
    if (!session.worktreeDir) return null;
    const { baseSha, effectiveBase } = session.worktreeLifecycle.snapshot();
    return streamRemovedTestLines(session.worktreeDir, baseSha, effectiveBase);
  }

  async function rescanMissingTestLines(session: VerifiableSession, cached: { key: string; run: VerificationRun }): Promise<VerificationRun> {
    const turnEndCountAtStart = turnEndCountOf(session.id);
    const removedTestLines = await scanRemovedTestLines(session);
    if (removedTestLines === null || cachedRunBySession.get(session.id) !== cached) return cached.run;
    const run: VerificationRun = { ...cached.run, removedTestLines };
    cachedRunBySession.set(session.id, { key: cached.key, run });
    if (turnEndCountOf(session.id) === turnEndCountAtStart) publish(run);
    return run;
  }

  function agentChecksOf(session: VerifiableSession): AgentCheck[] {
    return session.agentDoneLines.flatMap((line, index) => {
      if (line.command === undefined) return [];
      return [{ id: `${AGENT_DONE_CHECK_ID_PREFIX}${index + 1}`, command: line.command, isAllowed: session.allowedDoneCommands.includes(line.command) }];
    });
  }

  async function runAgentCheck(sessionId: string, worktreeDir: string, agentCheck: AgentCheck, timeoutMs: number): Promise<CheckOutcome> {
    if (!agentCheck.isAllowed) return skippedOutcome(agentCheck, AGENT_COMMAND_WAITING_REASON);
    return runCheck(sessionId, worktreeDir, agentCheck, timeoutMs);
  }

  async function runChecks(session: VerifiableSession, settings: VerificationSettings, agentChecks: readonly AgentCheck[], key: string, sig: string): Promise<VerificationRun> {
    const worktreeDir = session.worktreeDir;
    const turnEndCountAtStart = turnEndCountOf(session.id);
    publish({ sessionId: session.id, sig, status: 'running', checks: [], finishedAt: null, removedTestLines: null });
    const checks: CheckOutcome[] = [];
    for (const spec of settings.checks) {
      if (!attachedSessionIds.has(session.id)) break;
      checks.push(worktreeDir ? await runCheck(session.id, worktreeDir, spec, settings.timeoutSeconds * 1000) : skippedOutcome(spec, 'the session has no worktree'));
    }
    for (const agentCheck of agentChecks) {
      if (!attachedSessionIds.has(session.id)) break;
      checks.push(worktreeDir ? await runAgentCheck(session.id, worktreeDir, agentCheck, settings.timeoutSeconds * 1000) : skippedOutcome(agentCheck, 'the session has no worktree'));
    }
    const removedTestLines = attachedSessionIds.has(session.id) ? await scanRemovedTestLines(session) : null;
    const run: VerificationRun = { sessionId: session.id, sig, status: overallStatus(checks.filter((check) => !check.id.startsWith(AGENT_DONE_CHECK_ID_PREFIX))), checks, finishedAt: clock.nowMs(), removedTestLines };
    if (!attachedSessionIds.has(session.id)) return run;
    cachedRunBySession.set(session.id, { key, run });
    if (turnEndCountOf(session.id) === turnEndCountAtStart) publish(run);
    return run;
  }

  function ensureRun(session: VerifiableSession, settings: VerificationSettings, sig: string, { reuseFailed }: { reuseFailed: boolean }): Promise<VerificationRun> {
    const agentChecks = agentChecksOf(session);
    const key = `${sig}\0${settingsFingerprint(settings)}\0${JSON.stringify(agentChecks)}`;
    const cached = cachedRunBySession.get(session.id);
    if (cached?.key === key && (reuseFailed || cached.run.status === 'passed')) return cached.run.removedTestLines === null ? rescanMissingTestLines(session, cached) : Promise.resolve(cached.run);
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
    publish({ sessionId, sig: '', status: overallStatus(checks), checks, finishedAt: clock.nowMs(), removedTestLines: null });
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
    const run = await ensureRun(session, settings, tree.sig, { reuseFailed: true });
    if (isLatestTurnEnd()) publish(run);
  }

  async function gateMerge(session: VerifiableSession, tree: WorktreeTree | null): Promise<StandardsGateVerdict> {
    const lookup = lookupSettings(session);
    if (lookup.kind === 'invalid') return { allowed: false, reason: `the verification entry for this repository in config.json is invalid: ${lookup.message}` };
    if (lookup.kind === 'none' || !lookup.settings.gate.enabled) return { allowed: true };
    const settings = lookup.settings;
    const run = tree && !tree.dirty ? await ensureRun(session, settings, tree.sig, { reuseFailed: false }) : null;
    return decideStandardsGate({
      enabled: true,
      requiredCheckIds: settings.gate.required ?? settings.checks.map((check) => check.id),
      run,
      currentSig: tree?.sig ?? null,
      isTreeDirty: tree?.dirty === true,
    });
  }

  function runAllowedAgentCommands(session: VerifiableSession): void {
    if (!attachedSessionIds.has(session.id)) return;
    verifyAtTurnEnd(session).catch((error: unknown) => {
      dependencies.logger.warn(`[verification] ${session.id}: ${errorMessage(error)}`);
    });
  }

  function attachSession(session: VerifiableSession): void {
    attachedSessionIds.add(session.id);
    session.worktreeLifecycle.setMergeGate((tree) => gateMerge(session, tree));
    if (session.ephemeral && !session.ownerId) return;
    session.on('post-turn-check', () => {
      verifyAtTurnEnd(session).catch((error: unknown) => {
        dependencies.logger.warn(`[verification] ${session.id}: ${errorMessage(error)}`);
      });
    });
  }

  return {
    attachSession,
    runAllowedAgentCommands,
    latestRun: (sessionId) => publishedRunBySession.get(sessionId) ?? cachedRunBySession.get(sessionId)?.run ?? null,
    forgetSession: (sessionId) => {
      attachedSessionIds.delete(sessionId);
      killChecksOf(sessionId);
      cachedRunBySession.delete(sessionId);
      publishedRunBySession.delete(sessionId);
      turnEndCountBySession.delete(sessionId);
      invalidConfigMessageBySession.delete(sessionId);
      inFlightBySession.delete(sessionId);
    },
    stop: () => {
      for (const sessionId of [...liveCheckPidsBySession.keys()]) killChecksOf(sessionId);
    },
  };
}

export { createVerificationWiring };
export type { VerificationWiring };
