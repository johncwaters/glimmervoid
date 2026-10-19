import type { CoherenceHooksState } from '../../../shared/contracts/session.ts';

export type CoherenceHost = 'claude' | 'codex';

export function coherenceHooksStateFromCheck(exitCode: number | null): CoherenceHooksState {
  if (exitCode === 0) return { active: true };
  return { active: false, reason: exitCode === null ? 'check failed' : `check failed with exit code ${exitCode}` };
}

export function isTimedOutCommand(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'killed' in error && error.killed === true;
}
