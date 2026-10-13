import { errorMessage } from '#shared/text.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { buildDialogShell } from './modal.ts';

export function buildRepoCheckbox(name: string, repoPath: string, isChecked = false): HTMLLabelElement {
  const choice = el('label', 'dialog-checkbox-label');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'dialog-checkbox';
  checkbox.value = repoPath;
  checkbox.checked = isChecked;
  choice.append(checkbox, el('span', null, name));
  return choice;
}

function repoNameOf(repoPath: string): string {
  return repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? repoPath;
}

async function loadRepoChoices(sessionId: string): Promise<{ name: string; path: string; isMember: boolean }[]> {
  const [membership, scan] = await Promise.all([
    sendControlRequest('get-workspace-repos', { id: sessionId }),
    sendControlRequest('scan-repo-roots', {}).catch(() => null),
  ]);
  if (membership.type !== 'workspace-repos') throw new Error('Unexpected reply');
  if (!membership.ok) throw new Error(membership.error || 'Could not read the workspace');
  const choices = membership.repos.map((repoPath) => ({ name: repoNameOf(repoPath), path: repoPath, isMember: true }));
  const knownPaths = new Set(membership.repos);
  const directories = scan?.type === 'repo-roots-scanned' ? scan.directories : [];
  for (const project of directories.flatMap((directory) => directory.projects)) {
    if (knownPaths.has(project.path)) continue;
    knownPaths.add(project.path);
    choices.push({ name: project.name, path: project.path, isMember: false });
  }
  return choices;
}

export function openWorkspaceReposDialog(sessionId: string) {
  const { overlay, dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Workspace repositories' });
  const hint = el('p', 'dialog-message', 'Saving restarts the session and resumes its conversation. A removed repository keeps its workspace branch, so committed work survives.');
  const listEl = el('fieldset', 'dialog-workspace-list');
  listEl.setAttribute('aria-label', 'Workspace repositories');
  listEl.append(el('div', 'dialog-hint', 'Loading repositories...'));
  const statusEl = el('div', 'dialog-hint');
  statusEl.setAttribute('role', 'status');
  const errorEl = el('div', 'dialog-error');
  const btnSave = el('button', 'btn-dialog btn-dialog-confirm', 'Save');
  btnSave.type = 'button';
  btnSave.disabled = true;
  actions.append(btnSave);
  dialog.append(hint, listEl, statusEl, errorEl, actions);

  btnCancel.addEventListener('click', close);
  requestAnimationFrame(() => btnCancel.focus());

  loadRepoChoices(sessionId)
    .then((choices) => {
      if (!overlay.isConnected) return;
      listEl.textContent = '';
      for (const choice of choices) listEl.append(buildRepoCheckbox(choice.name, choice.path, choice.isMember));
      btnSave.disabled = false;
    })
    .catch((error) => {
      if (!overlay.isConnected) return;
      listEl.textContent = '';
      errorEl.textContent = `Could not load repositories: ${errorMessage(error)}`;
    });

  btnSave.addEventListener('click', () => {
    const repos = [...listEl.querySelectorAll<HTMLInputElement>('input:checked')].map((checkbox) => checkbox.value);
    if (repos.length < 2) {
      errorEl.textContent = 'Select at least two repositories.';
      return;
    }
    errorEl.textContent = '';
    btnSave.disabled = true;
    statusEl.textContent = 'Saving';
    sendControlRequest('set-workspace-repos', { id: sessionId, repos })
      .then((reply) => {
        if (!overlay.isConnected) return;
        if (reply.type === 'set-workspace-repos-result' && reply.ok) {
          close();
          return;
        }
        const failure = reply.type === 'set-workspace-repos-result' ? reply.error : null;
        errorEl.textContent = failure || 'Could not update the workspace.';
      })
      .catch((error) => {
        if (!overlay.isConnected) return;
        errorEl.textContent = `Could not update the workspace: ${errorMessage(error)}`;
      })
      .finally(() => {
        statusEl.textContent = '';
        btnSave.disabled = false;
      });
  });
}
