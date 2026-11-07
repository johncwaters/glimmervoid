import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { ProjectApprovals } from '#shared/contracts/secrets.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';

const SECRETS_NOTE = 'Secrets agents may read from your vault, per project. Revoking one makes the next request ask again.';

let approvalsByProject: readonly ProjectApprovals[] | null = null;
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

function projectGroup(row: ProjectApprovals): HTMLElement[] {
  return [el('h2', 'settings-view-subsection-title', row.project), ...row.approvals.map((approval) => approvalArticle(row.project, approval))];
}

function secretsContent(): HTMLElement[] {
  const intro = el('p', 'settings-view-section-description', SECRETS_NOTE);
  if (!approvalsByProject) return [intro, el('p', 'settings-view-setting-description', 'Waiting for the server to list approvals.')];
  if (approvalsByProject.length === 0) return [intro, el('p', 'settings-view-setting-description', 'No approvals yet. An agent that runs glimmervoid need asks on its session card first.')];
  return [intro, ...approvalsByProject.flatMap(projectGroup)];
}

function repaintSecrets(): void {
  if (!secretsContainer?.isConnected) return;
  secretsContainer.replaceChildren(...secretsContent());
}

function applySecretApprovals(message: ServerMessageOf<'secret-approvals'>): void {
  approvalsByProject = message.projects;
  repaintSecrets();
}

function renderSecretsPage(container: HTMLElement): void {
  secretsContainer = el('div', 'settings-view-stack');
  container.appendChild(secretsContainer);
  repaintSecrets();
}

export { applySecretApprovals, renderSecretsPage };
