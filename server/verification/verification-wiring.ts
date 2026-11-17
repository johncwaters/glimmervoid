import { spawn } from '../child-process-safe.ts';
import { buildAllowlistedChildEnv } from '../git/core/git-invocation-core.ts';
import { decideStandardsGate } from '../../session/core/merge-gate.ts';
import type { StandardsGateVerdict } from '../../session/core/merge-gate.ts';
import { VERIFICATION_OUTPUT_TAIL_BYTES } from '../../shared/contracts/verification.ts';
import type { CheckOutcome, VerificationRun, VerificationSettings } from '../../shared/contracts/verification.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import { clock } from '../../shared/clock.ts';
import { errorMessage } from '../../shared/text.ts';
import { launchArgvFor, overallStatus, parseCheckCommand, readVerificationSettings, redactSecretLines, settingsFingerprint } from './core/verification-core.ts';

const SECRET_ENV_NAME_PATTERN = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i;
const SANDBOX_SKIP_REASON = 'checks do not run while sessionSandbox is on, because they would run agent-edited code outside the sandbox';

interface WorktreeTree {
  sig: string;
  dirty: boolean;
}

interface VerifiableSession {
  id: string;
  path: string;
  ephemeral: boolean;
  hasOwnWorktree: boolean;
  worktreeDir: string | null;
  on(event: 'post-turn-check', listener: () => void): unknown;
  worktreeLifecycle: {
    computeWorktreeSignature(): Promise<WorktreeTree | null>;
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
  latestRun(sessionId: string): VerificationRun | null;
  forgetSession(sessionId: string): void;
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

function runCheckProcess(program: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number): Promise<CheckProcessResult> {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    let timedOut = false;
    const keepTail = (chunk: Buffer) => {
      const joined = Buffer.concat([tail, chunk]);
      tail = joined.length > VERIFICATION_OUTPUT_TAIL_BYTES ? joined.subarray(joined.length - VERIFICATION_OUTPUT_TAIL_BYTES) : joined;
    };
    const child = spawn(program, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', keepTail);
    child.stderr?.on('data', keepTail);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false, launchError: errorMessage(error), outputTail: '' });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, timedOut, launchError: null, outputTail: tail.toString('utf8') });
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
  const warnedInvalidRepos = new Set<string>();

  function publish(run: VerificationRun): void {
    dependencies.broadcastControl({ type: 'verification-run', id: run.sessionId, run });
  }

  function skippedOutcome(spec: VerificationSettings['checks'][number], reason: string): CheckOutcome {
    return { id: spec.id, command: spec.command, status: 'skipped', exitCode: null, outputTail: reason };
  }

  async function runCheck(worktreeDir: string, spec: VerificationSettings['checks'][number], timeoutMs: number): Promise<CheckOutcome> {
    if (dependencies.isSessionSandboxOn()) return skippedOutcome(spec, SANDBOX_SKIP_REASON);
    const argv = parseCheckCommand(spec.command);
    if (!argv) return skippedOutcome(spec, 'the command uses shell syntax, so it was not run; give a plain program and arguments');
    const env = buildAllowlistedChildEnv(process.env, platform);
    const { program, args } = launchArgvFor(argv, platform, env.ComSpec ?? env.COMSPEC ?? 'cmd.exe');
    const result = await runCheckProcess(program, args, worktreeDir, env, timeoutMs);
    const output = result.launchError ?? result.outputTail;
    return { id: spec.id, command: spec.command, status: statusOf(result), exitCode: result.exitCode, outputTail: redactSecretLines(output, secretEnvValues()) };
  }

  async function runChecks(session: VerifiableSession, settings: VerificationSettings, key: string, sig: string): Promise<VerificationRun> {
    const worktreeDir = session.worktreeDir;
    publish({ sessionId: session.id, sig, status: 'running', checks: [], finishedAt: null });
    const checks: CheckOutcome[] = [];
    for (const spec of settings.checks) {
      checks.push(worktreeDir ? await runCheck(worktreeDir, spec, settings.timeoutSeconds * 1000) : skippedOutcome(spec, 'the session has no worktree'));
    }
    const run: VerificationRun = { sessionId: session.id, sig, status: overallStatus(checks), checks, finishedAt: clock.nowMs() };
    cachedRunBySession.set(session.id, { key, run });
    publish(run);
    return run;
  }

  function ensureRun(session: VerifiableSession, settings: VerificationSettings, sig: string, { reuseFailed }: { reuseFailed: boolean }): Promise<VerificationRun> {
    const key = `${sig}\0${settingsFingerprint(settings)}`;
    const cached = cachedRunBySession.get(session.id);
    if (cached?.key === key && (reuseFailed || cached.run.status === 'passed')) return Promise.resolve(cached.run);
    const inFlight = inFlightBySession.get(session.id);
    if (inFlight?.key === key) return inFlight.promise;
    const waitForCurrent = inFlight ? inFlight.promise.catch(() => null) : Promise.resolve(null);
    const promise: Promise<VerificationRun> = waitForCurrent
      .then(() => runChecks(session, settings, key, sig))
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

  async function verifyAtTurnEnd(session: VerifiableSession): Promise<void> {
    const lookup = lookupSettings(session);
    if (lookup.kind !== 'ok' || !session.hasOwnWorktree) return;
    const tree = await session.worktreeLifecycle.computeWorktreeSignature();
    if (!tree) return;
    await ensureRun(session, lookup.settings, tree.sig, { reuseFailed: true });
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

  function attachSession(session: VerifiableSession): void {
    if (session.ephemeral) return;
    session.worktreeLifecycle.setMergeGate((tree) => gateMerge(session, tree));
    session.on('post-turn-check', () => {
      verifyAtTurnEnd(session).catch((error: unknown) => {
        dependencies.logger.warn(`[verification] ${session.id}: ${errorMessage(error)}`);
      });
    });
  }

  return {
    attachSession,
    latestRun: (sessionId) => cachedRunBySession.get(sessionId)?.run ?? null,
    forgetSession: (sessionId) => {
      cachedRunBySession.delete(sessionId);
      inFlightBySession.delete(sessionId);
    },
  };
}

export { createVerificationWiring };
export type { VerificationWiring };
