import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { buildDialogShell } from '../session-card/modal.ts';
import { coherenceAdoptReplyStatus, shouldOfferCoherenceAdopt } from './adopt-core.ts';
import { buildProjectCoherenceChip, findCoherenceTrendProjectId, hasCoherenceTrendReading, paintProjectHeaderCoherenceChip } from './trend-chip.ts';

let projectStatuses: ServerMessageOf<'project-coherence-status'>['projects'] = {};
let isCoherenceEnabled = false;
let factoryProjectIds = new Set<string>();
let refreshHeaders = () => {};
const adoptionsByProjectId = new Map<string, { isPending: boolean; text: string; ok: boolean }>();
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

function applyProjectCoherenceAdoptResponse(message: ServerMessageOf<'project-coherence-adopt-response'>) {
  adoptionsByProjectId.set(message.projectId, { isPending: false, text: coherenceAdoptReplyStatus(message), ok: message.ok });
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
  action.append(button, ...buildAdoptProgress());
  container.append(buildProjectCoherenceChip(), action);
  return container;
}

function buildAdoptProgress(): HTMLElement[] {
  const spinner = el('span', 'coherence-adopt-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const status = el('span', 'coherence-adopt-status');
  status.setAttribute('role', 'status');
  return [spinner, status];
}

function paintAdoptProgress(container: HTMLElement, adoption: { isPending: boolean; text: string; ok: boolean } | undefined, adoptingText = '') {
  const isAdopting = adoption?.isPending === true;
  const spinner = container.querySelector<HTMLElement>('.coherence-adopt-spinner');
  if (spinner) spinner.dataset.active = String(isAdopting);
  const status = container.querySelector<HTMLElement>('.coherence-adopt-status');
  if (!status) return;
  status.textContent = isAdopting ? adoptingText : adoption?.text ?? '';
  status.dataset.error = String(adoption?.ok === false && !isAdopting);
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
  if (action) paintAdoptProgress(action, adoption);
  container.hidden = !canAdopt && (!chip || chip.hidden);
}

function openAdoptDialog(projectId: string) {
  if (!shouldOfferCoherenceAdopt(hasCoherenceTrendReading(projectId), projectStatuses[projectId], isCoherenceEnabled, factoryProjectIds.has(projectId))) return;
  if (openDialog?.projectId === projectId) return;
  openDialog?.close();
  const shell = buildDialogShell({ title: 'Adopt Coherence', dialogClass: 'dialog coherence-adopt-dialog' });
  const description = el('p', 'dialog-message', 'This creates one commit on the project\'s integration branch and pushes it to origin. It adds coherence.config.json, pins Coherence in package.json and package-lock.json, as a dev dependency unless it is already a dependency, adds a node_modules ignore line if needed, and installs the Claude and Codex hook files.');
  const trust = el('p', 'dialog-message', 'Codex asks you to trust the new project hooks once in its /hooks screen.');
  const progress = el('p', 'coherence-adopt-progress');
  progress.append(...buildAdoptProgress());
  const adoptButton = el('button', 'btn-dialog btn-dialog-confirm', 'Adopt');
  adoptButton.type = 'button';
  shell.btnCancel.type = 'button';
  shell.actions.append(adoptButton);
  shell.dialog.append(description, trust, progress, shell.actions);
  const dialog = {
    projectId,
    paint: () => {
      const adoption = adoptionsByProjectId.get(projectId);
      adoptButton.disabled = adoption?.isPending === true;
      paintAdoptProgress(progress, adoption, 'Installing and pushing, this can take a minute');
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
    if (adoptionsByProjectId.get(projectId)?.isPending) return;
    const adoption = { isPending: true, text: '', ok: false };
    adoptionsByProjectId.set(projectId, adoption);
    void sendControlRequest('project-coherence-adopt', { projectId, confirm: true }, { timeoutMs: 330_000 })
      .then((message) => {
        if (adoptionsByProjectId.get(projectId) !== adoption) return;
        if (message.type !== 'project-coherence-adopt-response' || message.projectId !== projectId) return;
        applyProjectCoherenceAdoptResponse(message);
      })
      .catch((error: unknown) => {
        if (adoptionsByProjectId.get(projectId) !== adoption) return;
        const reason = error instanceof Error ? error.message : String(error);
        adoptionsByProjectId.set(projectId, { isPending: false, text: `Adopt failed: ${reason}`, ok: false });
        if (openDialog?.projectId === projectId) openDialog.paint();
        refreshHeaders();
      });
    dialog.paint();
    refreshHeaders();
  });
  dialog.paint();
  shell.btnCancel.focus();
}
