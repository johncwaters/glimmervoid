import type { HostStatus } from '#shared/contracts/hosts.ts';
import { createActionStatus, requestWithStatus } from '../action-status.ts';
import type { ActionStatus } from '../action-status.ts';
import { el } from '../dom-helpers.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { button } from '../ui/button.ts';
import { hostStatuses, hostStatusText } from './host-status.ts';

const DEFAULT_DASHBOARD_PORT = 3000;

let hostListElement: HTMLElement | null = null;
let addHostForm: HTMLElement | null = null;
const listStatus = createActionStatus('settings-hosts-status');

function hostLinkLine(status: HostStatus): string {
  const build = status.hostVersion ? `, build ${status.hostVersion}` : '';
  return `${status.sshTarget} port ${status.dashboardPort}: ${hostStatusText(status)}${build}`;
}

async function removeHost(status: HostStatus) {
  const reply = await requestWithStatus('remove-host', { id: status.id }, listStatus, { busyText: `Removing ${status.name}.` });
  if (reply?.type !== 'host-change-result') return;
  if (reply.ok) {
    listStatus.show('ok', `Removed ${status.name}. Its sessions keep running there.`);
    return;
  }
  listStatus.show('error', `Not removed: ${reply.error ?? 'the server refused the change.'}`);
}

function confirmRemoveHost(status: HostStatus) {
  openConfirmDialog({
    title: `Remove ${status.name}?`,
    message: 'This dashboard stops linking the host and its sessions leave the sidebar. They keep running on the host.',
    confirmLabel: 'Remove',
    danger: true,
    onConfirm: () => { void removeHost(status); },
  });
}

function hostRow(status: HostStatus): HTMLElement {
  const row = el('div', 'settings-host-row');
  row.dataset.state = status.state;
  const text = el('div', 'settings-readonly');
  text.append(el('span', 'settings-host-name', `${status.name} (${status.id})`), el('span', null, hostLinkLine(status)));
  row.append(text, button({ variant: 'secondary', label: 'Remove', action: 'remove-host', onClick: () => confirmRemoveHost(status) }));
  return row;
}

function renderHostList() {
  if (!hostListElement) return;
  const statuses = hostStatuses();
  if (statuses.length === 0) {
    hostListElement.replaceChildren(el('div', 'settings-readonly', 'No hosts linked yet. Add one below.'));
    return;
  }
  hostListElement.replaceChildren(...statuses.map(hostRow));
}

function labelledInput(labelText: string, name: string, placeholder: string): { field: HTMLElement; input: HTMLInputElement } {
  const field = el('label', 'settings-host-field');
  const input = el('input', 'settings-view-input');
  input.type = name === 'dashboardPort' ? 'number' : 'text';
  input.name = name;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  field.append(el('span', null, labelText), input);
  return { field, input };
}

async function submitHost(inputs: Record<'id' | 'name' | 'sshTarget' | 'dashboardPort', HTMLInputElement>, addButton: HTMLButtonElement, status: ActionStatus) {
  const hostId = inputs.id.value.trim();
  const host = {
    id: hostId,
    name: inputs.name.value.trim() || hostId,
    sshTarget: inputs.sshTarget.value.trim(),
    dashboardPort: inputs.dashboardPort.value.trim() ? Number(inputs.dashboardPort.value) : DEFAULT_DASHBOARD_PORT,
  };
  addButton.disabled = true;
  const reply = await requestWithStatus('add-host', { host }, status, { busyText: `Adding ${host.name}.` });
  addButton.disabled = false;
  if (reply?.type !== 'host-change-result') return;
  if (!reply.ok) {
    status.show('error', `Not added: ${reply.error ?? 'the server refused the change.'}`);
    return;
  }
  for (const input of Object.values(inputs)) input.value = '';
  status.show('ok', `Added ${host.name}. Linking now; its state shows above.`);
}

function buildAddHostForm(): HTMLElement {
  const form = el('form', 'settings-host-form');
  const id = labelledInput('Id', 'id', 'devbox');
  const name = labelledInput('Name', 'name', 'Same as the id');
  const sshTarget = labelledInput('Ssh target', 'sshTarget', 'me@devbox or a ~/.ssh/config alias');
  const dashboardPort = labelledInput('Dashboard port', 'dashboardPort', String(DEFAULT_DASHBOARD_PORT));
  const status = createActionStatus('settings-hosts-status');
  const addButton = button({ variant: 'secondary', label: 'Add host', action: 'add-host' });
  addButton.type = 'submit';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitHost({ id: id.input, name: name.input, sshTarget: sshTarget.input, dashboardPort: dashboardPort.input }, addButton, status);
  });
  const actions = el('div', 'settings-telegram-test');
  actions.append(addButton, status.element);
  const fields = el('div', 'settings-host-fields');
  fields.append(id.field, name.field, sshTarget.field, dashboardPort.field);
  form.append(fields, actions);
  return form;
}

export function buildHostsSettings(): HTMLElement {
  const block = el('div', 'settings-view-status-block settings-hosts');
  hostListElement = el('div', 'settings-host-list');
  renderHostList();
  addHostForm ??= buildAddHostForm();
  block.append(hostListElement, listStatus.element, addHostForm);
  return block;
}

export function refreshHostsSettings() {
  if (hostListElement?.isConnected) renderHostList();
}
