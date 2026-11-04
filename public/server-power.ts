import { shouldShowServerAction } from '#shared/client-trust.ts';
import { sendControlMsg } from './control-ws.ts';
import { getSessionCount } from './session-card/lifecycle.ts';
import { openConfirmDialog } from './session-card/modal.ts';

interface ServerPowerAction {
  type: 'restart-server' | 'shutdown';
  title: string;
  confirmLabel: string;
  danger: boolean;
  idleMessage: string;
  actionAfterKillingSessions: string;
}

let isShutdownShown = false;
const shutdownButtons = new Set<HTMLElement>();

function confirmServerPowerAction({ type, title, confirmLabel, danger, idleMessage, actionAfterKillingSessions }: ServerPowerAction) {
  const count = getSessionCount();
  const suffix = count > 1 ? 's' : '';
  const message = count > 0 ? `Kill ${count} session${suffix} and ${actionAfterKillingSessions}?` : idleMessage;
  openConfirmDialog({ title, message, confirmLabel, danger: danger || count > 0, onConfirm: () => sendControlMsg({ type }) });
}

function confirmServerRestart() {
  confirmServerPowerAction({ type: 'restart-server', title: 'Restart Server', confirmLabel: 'Restart', danger: false, idleMessage: 'Restart the server?', actionAfterKillingSessions: 'restart the server' });
}

function confirmServerShutdown() {
  confirmServerPowerAction({ type: 'shutdown', title: 'Shut Down Server', confirmLabel: 'Shut Down', danger: true, idleMessage: 'Shut down the server?', actionAfterKillingSessions: 'shut down the server' });
}

function applyClientTrust(trust: unknown) {
  isShutdownShown = shouldShowServerAction('shutdown', trust);
  for (const shutdownButton of shutdownButtons) {
    if (!shutdownButton.isConnected) {
      shutdownButtons.delete(shutdownButton);
      continue;
    }
    shutdownButton.hidden = !isShutdownShown;
  }
}

function trackShutdownButton(shutdownButton: HTMLElement) {
  shutdownButton.hidden = !isShutdownShown;
  shutdownButtons.add(shutdownButton);
}

export { applyClientTrust, confirmServerRestart, confirmServerShutdown, trackShutdownButton };
