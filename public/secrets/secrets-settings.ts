import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { PackSecretRow, ProjectApprovals } from '#shared/contracts/secrets.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';

const SECRETS_NOTE = 'Secrets agents may read from your vault, per project. Revoking one makes the next request ask again.';

let approvalsByProject: readonly ProjectApprovals[] | null = null;
let packSecrets: readonly PackSecretRow[] = [];
let secretsContainer: HTMLElement | null = null;

function approvalArticle(project: string, approval: ProjectApprovals['approvals'][number]): HTMLElement {
  const article = el('article', 'settings-view-setting');
  const text = el('div', 'settings-view-setting-text');
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', approval.name));
  text.append(heading, el('p', 'settings-view-setting-description', approval.isAllowed ? `Reads ${approval.reference ?? 'no reference yet'}` : 'Denied'));
  const control = el('div', 'settings-view-setting-control');
  control.append(button({ variant: 'secondary', label: 'Revoke', action: 'secret-revoke', onClick: () => { sendControlMsg({ type: 'secret-revoke', project, name: approval.name }); } }));
  article.append(text, control);
  return article;
}

function packSecretDescription(row: PackSecretRow): string {
  const usedBy = row.packs.length === 0 ? 'No approved pack uses it now' : `Used by ${row.packs.join(', ')}`;
  return `${usedBy}. ${row.reference === null ? 'Not linked yet; its servers stay out of sessions.' : `Reads ${row.reference}`}`;
}

function packSecretControl(row: PackSecretRow): HTMLElement {
  const control = el('div', 'settings-view-setting-control');
  if (row.reference !== null) {
    control.append(button({ variant: 'secondary', label: 'Unlink', action: 'pack-secret-unlink', onClick: () => { sendControlMsg({ type: 'pack-secret-link', name: row.name, reference: '' }); } }));
    return control;
  }
  const referenceInput = el('input', 'settings-view-input');
  referenceInput.type = 'text';
  referenceInput.placeholder = 'op://vault/item/field';
  referenceInput.autocomplete = 'off';
  referenceInput.spellcheck = false;
  referenceInput.setAttribute('aria-label', `Vault reference for ${row.name}`);
  control.append(referenceInput, button({ variant: 'secondary', label: 'Link', action: 'pack-secret-link', onClick: () => {
    const reference = referenceInput.value.trim();
    if (reference !== '') sendControlMsg({ type: 'pack-secret-link', name: row.name, reference });
  } }));
  return control;
}

function packSecretArticle(row: PackSecretRow): HTMLElement {
  const article = el('article', 'settings-view-setting');
  const text = el('div', 'settings-view-setting-text');
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', row.name));
  text.append(heading, el('p', 'settings-view-setting-description', packSecretDescription(row)));
  article.append(text, packSecretControl(row));
  return article;
}

function packSecretsGroup(): HTMLElement[] {
  if (packSecrets.length === 0) return [];
  return [el('h2', 'settings-view-subsection-title', 'Pack MCP servers'), ...packSecrets.map(packSecretArticle)];
}

function projectGroup(row: ProjectApprovals): HTMLElement[] {
  return [el('h2', 'settings-view-subsection-title', row.project), ...row.approvals.map((approval) => approvalArticle(row.project, approval))];
}

function secretsContent(): HTMLElement[] {
  const intro = el('p', 'settings-view-section-description', SECRETS_NOTE);
  if (!approvalsByProject) return [intro, el('p', 'settings-view-setting-description', 'Waiting for the server to list approvals.')];
  if (approvalsByProject.length === 0) return [intro, ...packSecretsGroup(), el('p', 'settings-view-setting-description', 'No project approvals yet. An agent that runs glimmervoid need asks on its session card first.')];
  return [intro, ...packSecretsGroup(), ...approvalsByProject.flatMap(projectGroup)];
}

function repaintSecrets(): void {
  if (!secretsContainer?.isConnected) return;
  secretsContainer.replaceChildren(...secretsContent());
}

function applySecretApprovals(message: ServerMessageOf<'secret-approvals'>): void {
  approvalsByProject = message.projects;
  packSecrets = message.packSecrets;
  repaintSecrets();
}

function renderSecretsPage(container: HTMLElement): void {
  secretsContainer = el('div', 'settings-view-stack');
  container.appendChild(secretsContainer);
  repaintSecrets();
}

export { applySecretApprovals, renderSecretsPage };
