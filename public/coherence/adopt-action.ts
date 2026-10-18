import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import type { ProjectAction } from '../project-actions-menu.ts';
import { buildDialogShell } from '../session-card/modal.ts';
import { createSignal } from '../signal.ts';
import { SIGNAL_TIER } from '../signal-core.ts';
import { coherenceAdoptReplyStatus, shouldOfferCoherenceAdopt } from './adopt-core.ts';
import { findCoherenceTrendProjectId, hasCoherenceTrendReading } from './trend-chip.ts';

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

function canAdoptProject(projectId: string) {
  return shouldOfferCoherenceAdopt(hasCoherenceTrendReading(projectId), projectStatuses[projectId], isCoherenceEnabled, factoryProjectIds.has(projectId));
}

export function projectAdoptAction(projectPath: string): ProjectAction | null {
  const projectId = findCoherenceTrendProjectId(projectPath);
  if (!projectId || !canAdoptProject(projectId) || adoptionsByProjectId.get(projectId)?.ok) return null;
  return {
    label: 'Adopt Coherence',
    hint: 'Set up the decision journal and its hooks',
    className: 'project-action-adopt-coherence',
    run: () => openAdoptDialog(projectId),
  };
}

export function buildProjectAdoptFailure(): HTMLElement {
  const container = el('span', 'coherence-adopt-failure');
  container.hidden = true;
  return container;
}

export function paintProjectAdoptFailure(slot: HTMLElement, projectPath: string) {
  const container = slot.querySelector<HTMLElement>('.coherence-adopt-failure');
  if (!container) return;
  const projectId = findCoherenceTrendProjectId(projectPath);
  const adoption = projectId ? adoptionsByProjectId.get(projectId) : undefined;
  const hasFailed = !!projectId && canAdoptProject(projectId) && adoption?.isPending === false && !adoption.ok;
  const failureText = hasFailed ? adoption.text : '';
  container.hidden = !hasFailed;
  if (container.dataset.failureText === failureText) return;
  container.dataset.failureText = failureText;
  if (!hasFailed) {
    container.replaceChildren();
    return;
  }
  container.replaceChildren(createSignal(
    { key: 'coherence-adopt-failed', text: 'Adopt failed', hoverText: failureText, look: { icon: 'failed', tone: 'danger' }, tier: SIGNAL_TIER.broken },
    { onActivate: () => openAdoptDialog(projectId) },
  ));
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

function openAdoptDialog(projectId: string) {
  if (!canAdoptProject(projectId)) return;
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
