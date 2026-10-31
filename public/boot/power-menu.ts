import { shouldShowServerAction } from '#shared/client-trust.ts';
import { sendControlMsg } from '../control-ws.ts';
import { queryTag } from '../dom-helpers.ts';
import { wirePopupMenuKeys } from '../menu.ts';
import { getSessionCount } from '../session-card/lifecycle.ts';
import { openConfirmDialog } from '../session-card/modal.ts';

const powerMenu = queryTag(document, '#power-menu', 'div');
const btnPower = queryTag(document, '#btn-power', 'button');
const powerMenuDropdown = queryTag(document, '#power-menu-dropdown', 'div');

function setPowerMenuOpen(isOpen: boolean) {
  powerMenu.classList.toggle('open', isOpen);
  btnPower.setAttribute('aria-expanded', String(isOpen));
}

function disablePowerButton() {
  btnPower.disabled = true;
}

interface ServerPowerAction {
  type: 'restart-server' | 'shutdown';
  title: string;
  confirmLabel: string;
  danger: boolean;
  idleMessage: string;
  actionAfterKillingSessions: string;
}

function confirmServerPowerAction({ type, title, confirmLabel, danger, idleMessage, actionAfterKillingSessions }: ServerPowerAction) {
  setPowerMenuOpen(false);
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
  const showShutdown = shouldShowServerAction('shutdown', trust);
  queryTag(document, '#btn-shutdown', 'button').hidden = !showShutdown;
  queryTag(document, '#menu-divider-shutdown', 'div').hidden = !showShutdown;
}

function mountPowerMenu() {
  btnPower.addEventListener('click', (e) => {
    e.stopPropagation();
    setPowerMenuOpen(!powerMenu.classList.contains('open'));
  });

  wirePopupMenuKeys({
    trigger: btnPower,
    menu: powerMenuDropdown,
    menuItems: () => [...powerMenuDropdown.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((menuItem) => !menuItem.hidden),
    isOpen: () => powerMenu.classList.contains('open'),
    open: () => setPowerMenuOpen(true),
    close: () => setPowerMenuOpen(false),
  });

  document.addEventListener('click', (e) => {
    if (!(e.target instanceof Node)) return;
    if (!powerMenu.contains(e.target)) setPowerMenuOpen(false);
  });
}

function wirePowerActions() {
  queryTag(document, '#btn-restart', 'button').addEventListener('click', confirmServerRestart);
  queryTag(document, '#btn-shutdown', 'button').addEventListener('click', confirmServerShutdown);
}

export { applyClientTrust, confirmServerRestart, disablePowerButton, mountPowerMenu, powerMenu, wirePowerActions };
