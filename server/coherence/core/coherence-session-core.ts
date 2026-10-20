import { isCompletedCommandFailure } from '../../core/command-failure-core.ts';
import { COHERENCE_HOOKS_INACTIVE, type CoherenceHooksState } from '../../../shared/contracts/session.ts';

export type CoherenceHost = 'claude' | 'codex';

export function coherenceHooksStateFromCheck(exitCode: number | null): CoherenceHooksState {
  if (exitCode === 0) return { active: true };
  return { active: false, reason: exitCode === null ? 'check failed' : `check failed with exit code ${exitCode}` };
}

export function isTimedOutCommand(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'killed' in error && error.killed === true;
}

export function shouldInstallCoherenceHooks({ isRepositoryConfigured, checkExitCode }: { isRepositoryConfigured: boolean; checkExitCode: number | null }): boolean {
  return isRepositoryConfigured && checkExitCode !== null && checkExitCode !== 0;
}

export function coherenceHealFailureReason(hooks: CoherenceHooksState): string | null {
  if (hooks.active || hooks.reason === COHERENCE_HOOKS_INACTIVE.codexHooksUntrusted) return null;
  return hooks.reason;
}

export function coherenceInstallFailureReason(error: unknown): string {
  if (isTimedOutCommand(error)) return 'hooks install timed out';
  if (isCompletedCommandFailure(error)) return `hooks install failed with exit code ${error.code}`;
  return 'hooks install failed';
}
