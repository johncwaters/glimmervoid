import { isCompletedCommandFailure } from '../core/command-failure-core.ts';
import type { CoherenceHooksState } from '../../shared/contracts/session.ts';
import { coherenceHooksStateFromCheck, isTimedOutCommand, type CoherenceHost } from './core/coherence-session-core.ts';

export async function checkCoherenceNativeHooks({ host, run }: {
  host: CoherenceHost; run: (args: string[]) => Promise<string>;
}): Promise<{ hooks: CoherenceHooksState; checkExitCode: number | null }> {
  try {
    await run(['hooks', '--check', '--host', host]);
    return { hooks: coherenceHooksStateFromCheck(0), checkExitCode: 0 };
  } catch (error) {
    if (isTimedOutCommand(error)) return { hooks: { active: false, reason: 'hooks check timed out' }, checkExitCode: null };
    const checkExitCode = isCompletedCommandFailure(error) ? error.code : null;
    return { hooks: coherenceHooksStateFromCheck(checkExitCode), checkExitCode };
  }
}
