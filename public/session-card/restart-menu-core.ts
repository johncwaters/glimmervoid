import type { SessionState } from '#shared/states.ts';
import { KILLABLE_STATES, STATES } from '#shared/states.ts';

export type RestartChoice = 'restart' | 'restart-fresh';

export function restartConfirmation(action: RestartChoice, state: string) {
  if (state !== STATES.RUNNING) return null;
  if (action === 'restart-fresh') {
    return {
      title: 'Restart fresh',
      message: 'This agent is mid-turn. A fresh restart ends this conversation and starts a new one. Restart anyway?',
      confirmLabel: 'Restart fresh',
      danger: true,
    };
  }
  return {
    title: 'Restart',
    message: 'This agent is mid-turn. Restarting interrupts the current turn and keeps this conversation. Restart anyway?',
    confirmLabel: 'Restart',
    danger: false,
  };
}

export function restartMessage(action: RestartChoice, state: string, sessionId: string) {
  const type = KILLABLE_STATES.includes(state as SessionState) ? 'force-restart' : 'restart';
  if (action === 'restart-fresh') return { type, id: sessionId, fresh: true };
  return { type, id: sessionId };
}

export interface RestartChoiceDeps {
  readState: () => string;
  send: (message: ReturnType<typeof restartMessage>) => void;
  confirm: (confirmation: NonNullable<ReturnType<typeof restartConfirmation>> & { onConfirm: () => void }) => void;
}

export function runRestartChoice(action: RestartChoice, sessionId: string, deps: RestartChoiceDeps) {
  const sendRestart = () => deps.send(restartMessage(action, deps.readState(), sessionId));
  const confirmation = restartConfirmation(action, deps.readState());
  if (!confirmation) { sendRestart(); return; }
  deps.confirm({ ...confirmation, onConfirm: sendRestart });
}
