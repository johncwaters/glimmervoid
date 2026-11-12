import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { SecretRequestCard } from '#shared/contracts/secrets.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { settingsHash } from '../settings/settings-link.ts';
import { paintStatusIcon } from '../status-icon.ts';
import { createLineIcon, KEY_ICON_PATH } from '../svg-dom.ts';
import { button, linkButton } from '../ui/button.ts';
import { sessionUIs } from './card-registry.ts';
import './secret-request-face.css';

const cardBySessionId = new Map<string, SecretRequestCard>();
const requestElementBySessionId = new Map<string, HTMLElement>();

const VAULT_SETTINGS_SECTION_ID = 'machine-vault';
const WAITING_TEXT = 'Waiting on your password manager. Confirm there if it asks.';
const NEEDS_SOURCE_TEXT = 'Nothing is shared until you allow it. First, pick where Glimmervoid reads secrets from.';
const ALWAYS_ALLOW_HINT = 'Always allow skips this card for these names in this project. Your password manager may still ask you to confirm. Revoke it in Settings > Vault.';

type Choice = 'deny' | 'allow-once' | 'allow-always';

function sendChoice(sessionId: string, choice: Choice): void {
  const names = cardBySessionId.get(sessionId)?.names ?? [];
  sendControlMsg({ type: 'secret-decision', id: sessionId, choice, names });
}

function namesText(names: readonly string[]): string {
  return names.join(', ');
}

function choiceButtons(sessionId: string, isDisabled: boolean): HTMLElement {
  const actions = el('div', 'secret-request-actions');
  actions.append(
    button({ variant: 'secondary', label: 'Deny', disabled: isDisabled, onClick: () => sendChoice(sessionId, 'deny') }),
    button({ variant: 'secondary', label: 'Always allow', disabled: isDisabled, onClick: () => sendChoice(sessionId, 'allow-always') }),
    button({ variant: 'primary', label: 'Allow once', disabled: isDisabled, onClick: () => sendChoice(sessionId, 'allow-once') }),
  );
  return actions;
}

function sourceActions(sessionId: string): HTMLElement {
  const actions = el('div', 'secret-request-actions');
  actions.append(
    button({ variant: 'secondary', label: 'Deny', onClick: () => sendChoice(sessionId, 'deny') }),
    linkButton({ variant: 'primary', label: 'Choose source', href: settingsHash(VAULT_SETTINGS_SECTION_ID) }),
  );
  return actions;
}

function keyedText(key: string, text: string): HTMLElement[] {
  return [el('span', 'secret-request-key', key), el('span', 'secret-request-value', text)];
}

function routeLine(from: string): HTMLElement {
  const line = el('div', 'secret-request-line');
  line.append(...keyedText('from', from), ...keyedText('into', '.env.local in this worktree'));
  return line;
}

function waitingLine(readingName: string | null): HTMLElement {
  const line = el('div', 'secret-request-line');
  line.setAttribute('role', 'status');
  const icon = el('span', 'secret-request-status-icon');
  paintStatusIcon(icon, 'working');
  const reading = readingName === null ? '' : `Reading ${readingName}. `;
  line.append(icon, el('span', 'secret-request-value', `${reading}${WAITING_TEXT}`));
  return line;
}

function reasonLine(reason: string): HTMLElement {
  const line = el('div', 'secret-request-reason');
  line.append(el('span', 'secret-request-key', "agent's reason"), el('q', 'secret-request-reason-text', reason));
  return line;
}

function failureLine(failure: NonNullable<SecretRequestCard['failure']>): HTMLElement {
  const block = el('div', 'secret-request-failure');
  block.setAttribute('role', 'alert');
  block.append(el('span', 'secret-request-failure-text', failure.message));
  if (failure.detail === '') return block;
  const details = el('details', 'secret-request-details');
  details.append(el('summary', 'secret-request-details-summary', 'Show details'), el('pre', 'secret-request-details-text', failure.detail));
  block.append(details);
  return block;
}

function statusLine(card: SecretRequestCard): HTMLElement {
  if (card.phase === 'needs-source') return el('div', 'secret-request-line', NEEDS_SOURCE_TEXT);
  if (card.phase === 'reading') return waitingLine(card.readingName);
  return routeLine(card.from ?? '');
}

function detailLine(card: SecretRequestCard): HTMLElement | null {
  if (card.phase === 'failed' && card.failure !== null) return failureLine(card.failure);
  if (card.reason !== null) return reasonLine(card.reason);
  return null;
}

function buildRequest(sessionId: string, card: SecretRequestCard): HTMLElement {
  const request = el('div', 'secret-request');
  request.dataset.phase = card.phase;
  request.setAttribute('role', 'group');
  request.setAttribute('aria-label', 'Secret request');
  const layout = el('div', 'secret-request-layout');
  const icon = el('span', 'secret-request-icon');
  icon.append(createLineIcon(KEY_ICON_PATH, '1.5'));
  const title = el('div', 'secret-request-title');
  title.append('Agent wants ', el('code', 'secret-request-names', namesText(card.names)));
  const actions = card.phase === 'needs-source' ? sourceActions(sessionId) : choiceButtons(sessionId, card.phase === 'reading');
  const detail = detailLine(card);
  const hint = card.phase === 'needs-source' ? [] : [el('div', 'secret-request-hint', ALWAYS_ALLOW_HINT)];
  layout.append(icon, title, actions, statusLine(card), ...(detail === null ? [] : [detail]), ...hint);
  request.append(layout);
  return request;
}

function cardKey(card: SecretRequestCard): string {
  return JSON.stringify(card);
}

function isPaintedCurrent(sessionId: string, cardElement: HTMLElement): boolean {
  const painted = requestElementBySessionId.get(sessionId);
  const card = cardBySessionId.get(sessionId);
  return painted !== undefined && card !== undefined && painted.dataset.card === cardKey(card) && painted.parentElement === cardElement;
}

function paintSecretRequest(sessionId: string) {
  const ui = sessionUIs.get(sessionId);
  if (ui && isPaintedCurrent(sessionId, ui.card)) return;
  requestElementBySessionId.get(sessionId)?.remove();
  requestElementBySessionId.delete(sessionId);
  const card = cardBySessionId.get(sessionId);
  if (!card || !ui) return;
  const request = buildRequest(sessionId, card);
  request.dataset.card = cardKey(card);
  requestElementBySessionId.set(sessionId, request);
  ui.termWrap.before(request);
}

function applySecretRequest(message: ServerMessageOf<'session-secret-request'>) {
  if (message.card === null) cardBySessionId.delete(message.id);
  if (message.card !== null) cardBySessionId.set(message.id, message.card);
  paintSecretRequest(message.id);
}

function applySecretRequestsSnapshot(message: ServerMessageOf<'secret-requests-snapshot'>) {
  const previousSessionIds = [...cardBySessionId.keys()];
  cardBySessionId.clear();
  for (const [sessionId, card] of Object.entries(message.requests)) cardBySessionId.set(sessionId, card);
  for (const sessionId of new Set([...previousSessionIds, ...cardBySessionId.keys()])) paintSecretRequest(sessionId);
}

export { applySecretRequest, applySecretRequestsSnapshot, paintSecretRequest };
