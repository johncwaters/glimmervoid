import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { CoherenceJournalOutput } from '../../shared/contracts/coherence.ts';
import { COHERENCE_HOOKS_INACTIVE, type CoherenceHooksState } from '../../shared/contracts/session.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { isCompletedCommandFailure } from '../core/command-failure-core.ts';
import { nulSeparatedPaths } from '../git/core/git-changed-paths-core.ts';
import { runHardenedGit } from '../git/git-workspace.ts';
import { buildAllowlistedChildEnv } from '../git/core/git-invocation-core.ts';
import { checkCoherenceNativeHooks } from './coherence-native-hooks.ts';
import {
  invariantQueryPaths, parseRunVerdicts, parseStatusVerdicts, totalityRunTargets,
  type CoherenceTurnReading, type CoherenceVerdictBaseline, type TotalityVerdicts,
} from './core/coherence-feed-core.ts';
import { coherenceHealFailureReason, coherenceInstallFailureReason, isTimedOutCommand, shouldInstallCoherenceHooks } from './core/coherence-session-core.ts';
import { judgeCoherenceSupport, readCoherenceBinScript } from './core/coherence-support-core.ts';

type CoherenceHealOutcome = { status: 'not-needed' | 'healed' } | { status: 'failed'; reason: string };

export interface CoherenceAttachment {
  hooks: CoherenceHooksState;
  version: string | null;
  refreshHooks(): Promise<CoherenceHooksState>;
  healHooks(): Promise<CoherenceHealOutcome>;
  readVerdictBaseline(): Promise<CoherenceVerdictBaseline | null>;
  rerunTouchedVerdicts(turn: { sinceHead: string; sessionId: string | null; standingInvariantIds: readonly string[]; isSpecCheckStanding: boolean }): Promise<CoherenceTurnReading>;
  readJournal(sessionId: string): Promise<CoherenceJournalOutput>;
}

export async function resolveCoherence({ worktree, host, isSettingOn, codexEnv = process.env, timeoutMs = 20_000, verdictTimeoutMs = 600_000 }: {
  worktree: string; host: string | null | undefined; isSettingOn: boolean; codexEnv?: NodeJS.ProcessEnv; timeoutMs?: number; verdictTimeoutMs?: number;
}): Promise<CoherenceAttachment | null> {
  if (!isSettingOn || (host !== 'claude' && host !== 'codex')) return null;
  const env = { ...buildAllowlistedChildEnv(process.env, process.platform), COHERENCE_NO_UPDATE_CHECK: '1' };
  let cliScript: string | null = null;
  let version: string | null = null;
  let unavailable: CoherenceHooksState | null = null;
  function runScript(script: string, args: string[], timeout = timeoutMs): Promise<string> {
    return execFileAsync(process.execPath, [script, ...args], { cwd: worktree, env, timeout, maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) => stdout);
  }
  async function run(args: string[], timeout = timeoutMs): Promise<string> {
    if (!cliScript) throw new Error('Coherence is not installed');
    return runScript(cliScript, args, timeout);
  }
  async function runForExitCode(args: string[]): Promise<{ exitCode: number; stdout: string }> {
    try {
      return { exitCode: 0, stdout: await run(args, verdictTimeoutMs) };
    } catch (error) {
      if (!isCompletedCommandFailure(error)) throw error;
      return { exitCode: error.code, stdout: 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '' };
    }
  }
  async function runGit(args: string[]): Promise<string> {
    return (await runHardenedGit(args, { cwd: worktree, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })).stdout;
  }
  async function locateCliScript(): Promise<string | null> {
    const packageDirectory = path.join(worktree, 'node_modules', '@posthog', 'coherence');
    try {
      const binScript = readCoherenceBinScript(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
      if (!binScript) return null;
      const scriptPath = await realpath(path.resolve(packageDirectory, binScript));
      return (await stat(scriptPath)).isFile() ? scriptPath : null;
    } catch {
      return null;
    }
  }
  async function judgeInstallation(script: string): Promise<{ version: string | null; unavailable: CoherenceHooksState | null }> {
    try {
      const support = judgeCoherenceSupport(await runScript(script, ['version']));
      if (support.status === 'unreadable') return { version: null, unavailable: { active: false, reason: 'version output unreadable' } };
      if (support.status === 'unsupported') return { version: support.version, unavailable: { active: false, reason: COHERENCE_HOOKS_INACTIVE.unsupportedVersion, version: support.version } };
      return { version: support.version, unavailable: null };
    } catch (error) {
      return { version: null, unavailable: { active: false, reason: isTimedOutCommand(error) ? 'version check timed out' : 'version check failed' } };
    }
  }
  let installationProbe: Promise<void> | null = null;
  async function probeInstallation(): Promise<void> {
    const script = await locateCliScript();
    if (!script) {
      cliScript = null;
      unavailable = { active: false, reason: COHERENCE_HOOKS_INACTIVE.notInstalled };
      return;
    }
    const judged = await judgeInstallation(script);
    cliScript = script;
    version = judged.version ?? version;
    unavailable = judged.unavailable;
  }
  const coherenceHost = host;
  let lastCheckExitCode: number | null = null;
  async function refreshHooks(): Promise<CoherenceHooksState> {
    if (installationProbe) await installationProbe;
    if (!cliScript || unavailable) {
      installationProbe ??= probeInstallation().finally(() => { installationProbe = null; });
      await installationProbe;
    }
    lastCheckExitCode = null;
    if (unavailable) return unavailable;
    const checked = await checkCoherenceNativeHooks({ worktree, host: coherenceHost, run, codexEnv });
    lastCheckExitCode = checked.checkExitCode;
    return checked.hooks;
  }
  async function isRepositoryConfigured(): Promise<boolean> {
    return stat(path.join(worktree, 'coherence.config.json')).then((entry) => entry.isFile(), () => false);
  }
  async function healHooks(): Promise<CoherenceHealOutcome> {
    if (installationProbe) await installationProbe;
    if (unavailable || !shouldInstallCoherenceHooks({ isRepositoryConfigured: await isRepositoryConfigured(), checkExitCode: lastCheckExitCode })) return { status: 'not-needed' };
    try {
      await run(['hooks', 'install', '--host', coherenceHost]);
    } catch (error) {
      return { status: 'failed', reason: coherenceInstallFailureReason(error) };
    }
    const failureReason = coherenceHealFailureReason(await refreshHooks());
    return failureReason === null ? { status: 'healed' } : { status: 'failed', reason: failureReason };
  }
  async function readSpecProblems(): Promise<boolean> {
    const { exitCode } = await runForExitCode(['spec', '--check']);
    if (exitCode !== 0 && exitCode !== 1) throw new Error(`spec --check exited ${exitCode}`);
    return exitCode === 1;
  }
  async function readHead(): Promise<string> {
    return (await runGit(['rev-parse', 'HEAD'])).trim();
  }
  async function runTotalityOracles(targets: string[] | 'all', sessionId: string | null): Promise<TotalityVerdicts> {
    const { exitCode, stdout } = await runForExitCode([
      'run', '--form', 'totality-oracle', ...(sessionId ? ['--session', sessionId] : []), '--agent', 'glimmervoid', '--json',
      ...(targets === 'all' ? [] : targets.flatMap((invariantId) => ['--invariant', invariantId])),
    ]);
    const verdicts = exitCode === 0 || exitCode === 1 ? parseRunVerdicts(stdout) : null;
    if (!verdicts) throw new Error(`run exited ${exitCode} without a readable verdict`);
    return verdicts;
  }
  async function readBaseline(): Promise<CoherenceVerdictBaseline | null> {
    if (installationProbe) await installationProbe;
    if (unavailable || !await isRepositoryConfigured()) return null;
    const verdicts = parseStatusVerdicts(await run(['run', '--status', '--json'], verdictTimeoutMs));
    if (!verdicts) throw new Error('run --status output unreadable');
    return { head: await readHead(), verdicts, hasSpecProblems: await readSpecProblems() };
  }
  let baselineRead: Promise<CoherenceVerdictBaseline | null> | null = null;
  function readVerdictBaseline(): Promise<CoherenceVerdictBaseline | null> {
    if (baselineRead) return baselineRead;
    const reading = readBaseline();
    baselineRead = reading;
    const forgetUnlessReady = (baseline: CoherenceVerdictBaseline | null) => { if (!baseline && baselineRead === reading) baselineRead = null; };
    reading.then(forgetUnlessReady, () => forgetUnlessReady(null));
    return reading;
  }
  async function readChangedPaths(sinceHead: string): Promise<string[]> {
    const trackedPaths = nulSeparatedPaths(await runGit(['diff', '-z', '--name-only', sinceHead]));
    const untrackedPaths = nulSeparatedPaths(await runGit(['ls-files', '-z', '--others', '--exclude-standard']));
    return [...new Set([...trackedPaths, ...untrackedPaths])];
  }
  async function readRunTargets(queryPaths: readonly string[] | 'all' | null, standingInvariantIds: readonly string[]): Promise<string[] | 'all'> {
    if (queryPaths === 'all') return 'all';
    const touchedTargets = queryPaths === null ? [] : totalityRunTargets(await run(['query', 'invariants', ...queryPaths], verdictTimeoutMs));
    if (touchedTargets === 'all') return 'all';
    return [...new Set([...touchedTargets, ...standingInvariantIds])];
  }
  async function rerunTouchedVerdicts({ sinceHead, sessionId, standingInvariantIds, isSpecCheckStanding }: { sinceHead: string; sessionId: string | null; standingInvariantIds: readonly string[]; isSpecCheckStanding: boolean }): Promise<CoherenceTurnReading> {
    if (installationProbe) await installationProbe;
    if (unavailable) throw new Error('Coherence is unavailable');
    const head = await readHead();
    const queryPaths = invariantQueryPaths(await readChangedPaths(sinceHead));
    if (queryPaths === null && standingInvariantIds.length === 0 && !isSpecCheckStanding) return { head, observed: {}, hasSpecProblems: null };
    const targets = await readRunTargets(queryPaths, standingInvariantIds);
    const observed = targets !== 'all' && targets.length === 0 ? {} : await runTotalityOracles(targets, sessionId);
    return { head, observed, hasSpecProblems: await readSpecProblems() };
  }
  const hooks = await refreshHooks();
  void readVerdictBaseline().catch(() => {});
  return {
    hooks, get version() { return version; }, refreshHooks, healHooks, readVerdictBaseline, rerunTouchedVerdicts,
    async readJournal(sessionId) {
      if (installationProbe) await installationProbe;
      if (unavailable) throw new Error('Coherence is unavailable');
      return CoherenceJournalOutput.parse(JSON.parse(await run(['journal', '--json', '--session', sessionId])));
    },
  };
}
