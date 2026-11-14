import type { CommitSigningAction, CommitSigningStatus } from '#shared/contracts/commit-signing.ts';
import { createActionStatus, requestFailureText } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el, writeClipboardText } from '../dom-helpers.ts';
import { openExternalUrl } from '../external-link.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { button } from '../ui/button.ts';
import { COMMIT_SIGNING_CONTROLS, commitSigningViewOf, GITHUB_SIGNING_KEY_PAGE } from './commit-signing-core.ts';
import type { CommitSigningControl } from './commit-signing-core.ts';

const SIGNING_REQUEST_TIMEOUT_MS = 45_000;
const BUSY_TEXT = { read: '', setup: 'Setting up commit signing.', register: 'Registering the key on GitHub.', remove: 'Removing the key.' } as const;

function buildCommitSigningSection(): HTMLElement {
  let status: CommitSigningStatus | null | 'reading' = 'reading';
  let isRequesting = false;
  const article = el('article', 'settings-view-setting');
  const text = el('div', 'settings-view-setting-text');
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', 'Commit signing'));
  const description = el('p', 'settings-view-setting-description');
  const publicKeyText = el('pre', 'settings-vault-test-details-text');
  text.append(heading, description, publicKeyText);
  const requestStatus = createActionStatus('settings-vault-test-status');
  const buttonsByControl: Record<CommitSigningControl, HTMLButtonElement> = {
    setup: button({ variant: 'primary', label: 'Set up', action: 'commit-signing-setup', onClick: () => { void request('setup'); } }),
    register: button({ variant: 'primary', label: 'Register on GitHub', action: 'commit-signing-register', onClick: () => { void request('register'); } }),
    'open-github': button({ variant: 'secondary', label: 'Open GitHub', action: 'commit-signing-open-github', onClick: () => { openExternalUrl(GITHUB_SIGNING_KEY_PAGE); } }),
    copy: button({ variant: 'secondary', label: 'Copy public key', action: 'commit-signing-copy', onClick: () => { void copyPublicKey(); } }),
    remove: button({ variant: 'secondary', label: 'Remove', action: 'commit-signing-remove', onClick: confirmRemove }),
  };
  const controlRow = el('div', 'settings-telegram-test');
  controlRow.append(...COMMIT_SIGNING_CONTROLS.map((controlName) => buttonsByControl[controlName]), requestStatus.element);
  const control = el('div', 'settings-view-setting-control');
  control.append(controlRow);
  article.append(text, control);

  function paint(): void {
    const view = commitSigningViewOf(status);
    description.textContent = view.text;
    publicKeyText.hidden = view.publicKey === null;
    publicKeyText.textContent = view.publicKey ?? '';
    for (const controlName of COMMIT_SIGNING_CONTROLS) {
      buttonsByControl[controlName].hidden = !view.controls.includes(controlName);
      buttonsByControl[controlName].disabled = isRequesting;
    }
    if (!isRequesting && view.problem !== null) requestStatus.show('error', view.problem);
  }

  async function copyPublicKey(): Promise<void> {
    const publicKey = status !== null && status !== 'reading' ? status.publicKey : null;
    const copying = publicKey === null ? null : writeClipboardText(publicKey);
    if (copying === null) return requestStatus.show('error', 'This browser blocked the clipboard. Select the key text and copy it.');
    await copying.then(() => requestStatus.show('ok', 'Public key copied.'), () => requestStatus.show('error', 'This browser blocked the clipboard. Select the key text and copy it.'));
  }

  function confirmRemove(): void {
    openConfirmDialog({
      title: 'Remove the signing key?',
      message: 'This deletes the key on this host and on GitHub. Commits already signed with it stop showing as Verified.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () => { void request('remove'); },
    });
  }

  async function request(action: CommitSigningAction): Promise<void> {
    if (action !== 'read') {
      isRequesting = true;
      requestStatus.show('busy', BUSY_TEXT[action]);
      paint();
    }
    try {
      const reply = await sendControlRequest('commit-signing', { action }, { timeoutMs: SIGNING_REQUEST_TIMEOUT_MS });
      if (reply.type !== 'commit-signing-result') throw new Error('The server sent an unexpected reply.');
      status = reply.status;
      requestStatus.clear();
    } catch (reason) {
      if (status === 'reading') status = null;
      requestStatus.show('error', requestFailureText(reason, SIGNING_REQUEST_TIMEOUT_MS));
    }
    isRequesting = false;
    paint();
  }

  paint();
  void request('read');
  return article;
}

export { buildCommitSigningSection };
