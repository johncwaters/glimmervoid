import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { CoherenceJournalOutput } from '../../shared/contracts/coherence.ts';
import { COHERENCE_HOOKS_INACTIVE, type CoherenceHooksState } from '../../shared/contracts/session.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { buildAllowlistedChildEnv } from '../git/core/git-invocation-core.ts';
import { checkCoherenceNativeHooks } from './coherence-native-hooks.ts';
import { isTimedOutCommand } from './core/coherence-session-core.ts';
import { judgeCoherenceSupport, readCoherenceBinScript } from './core/coherence-support-core.ts';

export interface CoherenceAttachment {
  hooks: CoherenceHooksState;
  version: string | null;
  refreshHooks(): Promise<CoherenceHooksState>;
  readJournal(sessionId: string): Promise<CoherenceJournalOutput>;
}

export async function resolveCoherence({ worktree, host, isSettingOn, codexEnv = process.env, timeoutMs = 20_000 }: {
  worktree: string; host: string | null | undefined; isSettingOn: boolean; codexEnv?: NodeJS.ProcessEnv; timeoutMs?: number;
}): Promise<CoherenceAttachment | null> {
  if (!isSettingOn || (host !== 'claude' && host !== 'codex')) return null;
  const env = { ...buildAllowlistedChildEnv(process.env, process.platform), COHERENCE_NO_UPDATE_CHECK: '1' };
  let cliScript: string | null = null;
  let version: string | null = null;
  let unavailable: CoherenceHooksState | null = null;
  function runScript(script: string, args: string[]): Promise<string> {
    return execFileAsync(process.execPath, [script, ...args], { cwd: worktree, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) => stdout);
  }
  async function run(args: string[]): Promise<string> {
    if (!cliScript) throw new Error('Coherence is not installed');
    return runScript(cliScript, args);
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
  async function refreshHooks(): Promise<CoherenceHooksState> {
    if (installationProbe) await installationProbe;
    if (!cliScript || unavailable) {
      installationProbe ??= probeInstallation().finally(() => { installationProbe = null; });
      await installationProbe;
    }
    if (unavailable) return unavailable;
    return checkCoherenceNativeHooks({ worktree, host: coherenceHost, run, codexEnv });
  }
  return {
    hooks: await refreshHooks(), get version() { return version; }, refreshHooks,
    async readJournal(sessionId) {
      if (installationProbe) await installationProbe;
      if (unavailable) throw new Error('Coherence is unavailable');
      return CoherenceJournalOutput.parse(JSON.parse(await run(['journal', '--json', '--session', sessionId])));
    },
  };
}
