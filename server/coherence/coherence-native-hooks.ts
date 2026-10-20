import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { getAdapter } from '../../session/adapters/index.ts';
import { COHERENCE_HOOKS_INACTIVE, type CoherenceHooksState } from '../../shared/contracts/session.ts';
import { isMissingFileError } from '../../shared/text.ts';
import { isCompletedCommandFailure } from '../core/command-failure-core.ts';
import { areCodexHooksTrusted, codexHookHashes, trustedCodexHookHashes } from './core/coherence-codex-trust-core.ts';
import { coherenceHooksStateFromCheck, isTimedOutCommand, type CoherenceHost } from './core/coherence-session-core.ts';

async function readTextOrEmpty(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8').catch((error: unknown) => {
    if (isMissingFileError(error)) return '';
    throw error;
  });
}

async function areProjectCodexHooksTrusted(worktree: string, codexEnv: NodeJS.ProcessEnv): Promise<boolean> {
  const operatorConfigPath = getAdapter('codex')?.operatorConfigPath?.(codexEnv) ?? null;
  if (operatorConfigPath === null) return false;
  const trustedHashes = trustedCodexHookHashes(await readTextOrEmpty(operatorConfigPath));
  const hooksFileText = await readTextOrEmpty(path.join(worktree, '.codex', 'hooks.json'));
  const roots = new Set([worktree, await realpath(worktree)]);
  return [...roots].some((root) => areCodexHooksTrusted(codexHookHashes(path.join(root, '.codex', 'hooks.json'), hooksFileText), trustedHashes));
}

export async function checkCoherenceNativeHooks({ worktree, host, run, codexEnv }: {
  worktree: string; host: CoherenceHost; run: (args: string[]) => Promise<string>; codexEnv: NodeJS.ProcessEnv;
}): Promise<{ hooks: CoherenceHooksState; checkExitCode: number | null }> {
  try {
    await run(['hooks', '--check', '--host', host]);
    if (host === 'codex' && !await areProjectCodexHooksTrusted(worktree, codexEnv)) {
      return { hooks: { active: false, reason: COHERENCE_HOOKS_INACTIVE.codexHooksUntrusted }, checkExitCode: 0 };
    }
    return { hooks: coherenceHooksStateFromCheck(0), checkExitCode: 0 };
  } catch (error) {
    if (isTimedOutCommand(error)) return { hooks: { active: false, reason: 'hooks check timed out' }, checkExitCode: null };
    const checkExitCode = isCompletedCommandFailure(error) ? error.code : null;
    return { hooks: coherenceHooksStateFromCheck(checkExitCode), checkExitCode };
  }
}
