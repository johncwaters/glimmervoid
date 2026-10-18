import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { nextRequestId, sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { buildDialogShell } from '../session-card/modal.ts';
import { coherenceAdoptReplyStatus, shouldOfferCoherenceAdopt } from './adopt-core.ts';
import { buildProjectCoherenceChip, findCoherenceTrendProjectId, hasCoherenceTrendReading, paintProjectHeaderCoherenceChip } from './trend-chip.ts';

let projectStatuses: ServerMessageOf<'project-coherence-status'>['projects'] = {};
let isCoherenceEnabled = false;
let factoryProjectIds = new Set<string>();
let refreshHeaders = () => {};
const adoptionsByProjectId = new Map<string, { requestId: string | null; text: string; ok: boolean }>();
let openDialog: { projectId: string; paint: () => void; close: () => void } | null = null;

export function setProjectCoherenceAdoptRefresh(refresh: () => void) {
  refreshHeaders = refresh;
}

export function setProjectCoherenceAdoptEnabled(isEnabled: boolean) {
  isCoherenceEnabled = isEnabled;
  refreshHeaders();
}

export function setCoherenceAdoptFactoryProjects(projects: readonly { projectId: string }[]) {
  factoryProjectIds = new Set(projects.map((project) => project.projectId));
  refreshHeaders();
}

export function applyProjectCoherenceStatus(message: ServerMessageOf<'project-coherence-status'>) {
  projectStatuses = message.projects;
  for (const [projectId, adoption] of adoptionsByProjectId) {
    if (adoption.ok) adoptionsByProjectId.delete(projectId);
  }
  refreshHeaders();
}

export function applyProjectCoherenceAdoptResponse(message: ServerMessageOf<'project-coherence-adopt-response'>) {
  const adoption = adoptionsByProjectId.get(message.projectId);
  if (!adoption?.requestId || adoption.requestId !== message.requestId) return;
  adoptionsByProjectId.set(message.projectId, { requestId: null, text: coherenceAdoptReplyStatus(message), ok: message.ok });
  if (openDialog?.projectId === message.projectId) {
    if (message.ok) openDialog.close();
    if (!message.ok) openDialog?.paint();
  }
  refreshHeaders();
}

export function buildProjectCoherenceAction(): HTMLElement {
  const container = el('div', 'coherence-project-action');
  const action = el('div', 'coherence-adopt-action');
  const button = el('button', 'coherence-journal-button', 'Adopt Coherence');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', () => {
    if (container.dataset.projectId) openAdoptDialog(container.dataset.projectId);
  });
  const status = el('span', 'coherence-adopt-status');
  status.setAttribute('role', 'status');
  action.append(button, status);
  container.append(buildProjectCoherenceChip(), action);
  return container;
}

export function paintProjectHeaderCoherenceAction(slot: HTMLElement, projectPath: string) {
  const container = slot.querySelector<HTMLElement>('.coherence-project-action');
  if (!container) return;
  const projectId = findCoherenceTrendProjectId(projectPath);
  const projectStatus = projectId ? projectStatuses[projectId] : undefined;
  const canAdopt = !!projectId && shouldOfferCoherenceAdopt(hasCoherenceTrendReading(projectId), projectStatus, isCoherenceEnabled, factoryProjectIds.has(projectId));
  const adoption = projectId ? adoptionsByProjectId.get(projectId) : undefined;
  container.dataset.projectId = projectId ?? '';
  paintProjectHeaderCoherenceChip(slot, projectPath);
  const chip = container.querySelector<HTMLElement>('.coherence-trend-chip');
  const action = container.querySelector<HTMLElement>('.coherence-adopt-action');
  if (action) action.hidden = !canAdopt;
  const button = action?.querySelector('button');
  if (button) button.hidden = adoption?.ok === true;
  const status = action?.querySelector('.coherence-adopt-status');
  if (status) status.textContent = adoption?.text ?? '';
  container.hidden = !canAdopt && (!chip || chip.hidden);
}

function openAdoptDialog(projectId: string) {
  if (!shouldOfferCoherenceAdopt(hasCoherenceTrendReading(projectId), projectStatuses[projectId], isCoherenceEnabled, factoryProjectIds.has(projectId))) return;
  if (openDialog?.projectId === projectId) return;
  openDialog?.close();
  const shell = buildDialogShell({ title: 'Adopt Coherence', dialogClass: 'dialog coherence-adopt-dialog' });
  const description = el('p', 'dialog-message', 'This creates one commit on the project\'s integration branch and pushes it to origin. It adds coherence.config.json, adds or updates package.json and package-lock.json with Coherence as a dev dependency, adds a node_modules ignore line if needed, and installs the Claude and Codex hook files.');
  const trust = el('p', 'dialog-message', 'Codex asks you to trust the new project hooks once in its /hooks screen.');
  const status = el('span', 'coherence-adopt-status');
  status.setAttribute('role', 'status');
  const adoptButton = el('button', 'btn-dialog btn-dialog-confirm', 'Adopt');
  adoptButton.type = 'button';
  shell.btnCancel.type = 'button';
  shell.actions.append(adoptButton, status);
  shell.dialog.append(description, trust, shell.actions);
  const dialog = {
    projectId,
    paint: () => {
      const adoption = adoptionsByProjectId.get(projectId);
      adoptButton.disabled = adoption?.requestId != null;
      status.textContent = adoption?.text ?? '';
      status.dataset.error = String(adoption?.ok === false && adoption.requestId === null);
    },
    close: () => {
      if (openDialog === dialog) openDialog = null;
      shell.close();
    },
  };
  openDialog = dialog;
  shell.btnCancel.addEventListener('click', dialog.close);
  shell.overlay.addEventListener('click', (event) => {
    if (event.target === shell.overlay && openDialog === dialog) openDialog = null;
  });
  shell.dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && openDialog === dialog) openDialog = null;
    if (event.key !== 'Tab' || !adoptButton.disabled) return;
    event.preventDefault();
    shell.btnCancel.focus();
  });
  adoptButton.addEventListener('click', () => {
    if (adoptionsByProjectId.get(projectId)?.requestId) return;
    const requestId = nextRequestId('coherence-adopt');
    adoptionsByProjectId.set(projectId, { requestId, text: 'Adopting', ok: false });
    if (!sendControlMsg({ type: 'project-coherence-adopt', projectId, requestId, confirm: true })) {
      adoptionsByProjectId.set(projectId, { requestId: null, text: 'Adopt failed: Not connected', ok: false });
    }
    dialog.paint();
    refreshHeaders();
  });
  dialog.paint();
  shell.btnCancel.focus();
}
