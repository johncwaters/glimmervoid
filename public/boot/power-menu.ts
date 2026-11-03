import { shouldShowServerAction } from '#shared/client-trust.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el, queryTag } from '../dom-helpers.ts';
import { wirePopupMenuKeys } from '../menu.ts';
import { getSessionCount } from '../session-card/lifecycle.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { createLineIcon, POWER_ICON_PATH } from '../svg-dom.ts';
import { outlineIconButton } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';

function powerMenuItem(className: string, glyph: string, label: string, onClick: () => void) {
  const menuItem = createPressable(`menu-item ${className}`);
  menuItem.setAttribute('role', 'menuitem');
  menuItem.append(el('span', 'menu-item-glyph', glyph), label);
  menuItem.addEventListener('click', onClick);
  return menuItem;
}

const powerMenu = queryTag(document, '#power-menu', 'div');
const btnPower = outlineIconButton({ label: 'Server power', icon: createLineIcon(POWER_ICON_PATH, '1.6'), action: 'open-power-menu', states: ['idle'] }).element;
btnPower.setAttribute('aria-haspopup', 'menu');
btnPower.setAttribute('aria-expanded', 'false');
btnPower.setAttribute('aria-controls', 'power-menu-dropdown');
const powerMenuDropdown = queryTag(document, '#power-menu-dropdown', 'div');
const btnRestart = powerMenuItem('menu-item-warning', String.fromCharCode(0x21ba), 'Restart Server', confirmServerRestart);
const btnShutdown = powerMenuItem('menu-item-danger', String.fromCharCode(0x25a0), 'Shut Down', confirmServerShutdown);
powerMenu.prepend(btnPower);
powerMenuDropdown.prepend(btnRestart);
powerMenuDropdown.append(btnShutdown);

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
  btnShutdown.hidden = !showShutdown;
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

export { applyClientTrust, confirmServerRestart, disablePowerButton, mountPowerMenu, powerMenu };
