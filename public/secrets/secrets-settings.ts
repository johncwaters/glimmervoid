import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { ProjectApprovals } from '#shared/contracts/secrets.ts';
import { SECRET_MANAGER_LABELS } from '#shared/contracts/secrets.ts';
import type { SettingsSetting } from '#shared/settings/registry.ts';
import { createActionStatus, requestFailureText } from '../action-status.ts';
import type { ActionStatusTone } from '../action-status.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { storedValue } from '../settings/settings-panel-state.ts';
import { button } from '../ui/button.ts';
import { buildGithubConnectSection } from './github-connect.ts';

const SECRETS_NOTE = 'Secrets agents may read from your password manager, per project. Revoking one makes the next request ask again.';

const PASSWORD_MANAGER_LABEL = SECRET_MANAGER_LABELS['1password'];
const SOURCE_TEST_TIMEOUT_MS = 130_000;

let approvalsByProject: readonly ProjectApprovals[] | null = null;
let secretsContainer: HTMLElement | null = null;

function approvalArticle(project: string, approval: ProjectApprovals['approvals'][number]): HTMLElement {
  const article = el('article', 'settings-view-setting');
  const text = el('div', 'settings-view-setting-text');
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', approval.name));
  text.append(heading, el('p', 'settings-view-setting-description', approval.isAllowed ? 'Always allowed' : 'Denied'));
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

function testDetails(detail: string): HTMLElement {
  const details = el('details', 'settings-vault-test-details');
  details.append(el('summary', 'settings-vault-test-details-summary', 'Show details'), el('pre', 'settings-vault-test-details-text', detail));
  return details;
}

interface VaultTestView {
  tone: ActionStatusTone;
  message: string;
  detail: string;
}

let vaultTestView: VaultTestView | null = null;
let repaintVaultTest: (() => void) | null = null;

function showVaultTest(view: VaultTestView): void {
  vaultTestView = view;
  repaintVaultTest?.();
}

async function runVaultTest(lookIn: string): Promise<void> {
  showVaultTest({ tone: 'busy', message: `Waiting on ${PASSWORD_MANAGER_LABEL}. Confirm there if it asks.`, detail: '' });
  try {
    const reply = await sendControlRequest('secret-source-test', { lookIn }, { timeoutMs: SOURCE_TEST_TIMEOUT_MS });
    if (reply.type !== 'secret-source-test-result') return showVaultTest({ tone: 'error', message: 'The server sent an unexpected reply.', detail: '' });
    showVaultTest({ tone: reply.ok ? 'ok' : 'error', message: reply.message, detail: reply.detail });
  } catch (reason) {
    showVaultTest({ tone: 'error', message: requestFailureText(reason, SOURCE_TEST_TIMEOUT_MS), detail: '' });
  }
}

function buildVaultConnectionSlot(lookInSetting: SettingsSetting): HTMLElement {
  const slot = el('div', 'settings-view-status-slot settings-vault-connection');
  const testButton = button({ variant: 'secondary', label: 'Test connection', action: 'test-vault-connection', onClick: () => { void runVaultTest(String(storedValue(lookInSetting) ?? '')); } });
  const testStatus = createActionStatus('settings-vault-test-status');
  const detailHolder = el('div', 'settings-vault-test-detail');
  const paint = () => {
    testButton.disabled = vaultTestView?.tone === 'busy';
    detailHolder.replaceChildren();
    if (!vaultTestView) return testStatus.clear();
    testStatus.show(vaultTestView.tone, vaultTestView.message);
    if (vaultTestView.detail !== '') detailHolder.append(testDetails(vaultTestView.detail));
  };
  repaintVaultTest = paint;
  paint();
  const testRow = el('div', 'settings-telegram-test');
  testRow.append(testButton, testStatus.element);
  slot.append(el('p', 'settings-view-setting-description', `Password manager: ${PASSWORD_MANAGER_LABEL}`), testRow, detailHolder);
  return slot;
}

function renderSecretsPage(container: HTMLElement): void {
  const githubStack = el('div', 'settings-view-stack');
  githubStack.append(buildGithubConnectSection());
  secretsContainer = el('div', 'settings-view-stack');
  container.append(githubStack, secretsContainer);
  repaintSecrets();
}

export { applySecretApprovals, buildVaultConnectionSlot, renderSecretsPage };
