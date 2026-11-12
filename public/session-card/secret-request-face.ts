import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { SecretRequestCard } from '#shared/contracts/secrets.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { settingsHash } from '../settings/settings-link.ts';
import { paintStatusIcon } from '../status-icon.ts';
import { button, linkButton } from '../ui/button.ts';
import { sessionUIs } from './card-registry.ts';
import './secret-request-face.css';

const cardBySessionId = new Map<string, SecretRequestCard>();
const requestElementBySessionId = new Map<string, HTMLElement>();

const VAULT_SETTINGS_SECTION_ID = 'machine-vault';
const WAITING_TEXT = 'Waiting on your password manager. Confirm there if it asks.';
const NEEDS_SOURCE_TEXT = 'Nothing is shared until you allow it. First, pick where Glimmervoid reads secrets from.';

type Choice = 'deny' | 'allow-once' | 'allow-always';

function sendChoice(sessionId: string, choice: Choice): void {
  const names = cardBySessionId.get(sessionId)?.names ?? [];
  sendControlMsg({ type: 'secret-decision', id: sessionId, choice, names });
}

function namesText(names: readonly string[]): string {
  return names.join(', ');
}

function labeledLine(label: string, text: string): HTMLElement {
  const line = el('div', 'secret-request-line');
  line.append(el('span', 'secret-request-label', label), el('span', 'secret-request-line-text', text));
  return line;
}

function reasonBlock(reason: string): HTMLElement {
  const block = el('div', 'secret-request-reason');
  block.append(el('span', 'secret-request-label', "Agent's reason"), el('p', 'secret-request-reason-text', reason));
  return block;
}

function choiceButtons(sessionId: string, isDisabled: boolean): HTMLElement {
  const actions = el('div', 'secret-request-actions');
  const allowButtons = el('div', 'secret-request-allow');
  allowButtons.append(
    button({ variant: 'secondary', label: 'Always allow', disabled: isDisabled, onClick: () => sendChoice(sessionId, 'allow-always') }),
    button({ variant: 'primary', label: 'Allow once', disabled: isDisabled, onClick: () => sendChoice(sessionId, 'allow-once') }),
  );
  actions.append(button({ variant: 'secondary', label: 'Deny', disabled: isDisabled, onClick: () => sendChoice(sessionId, 'deny') }), allowButtons);
  return actions;
}

function waitingStatus(readingName: string | null): HTMLElement {
  const status = el('div', 'secret-request-status');
  status.setAttribute('role', 'status');
  const icon = el('span', 'secret-request-status-icon');
  paintStatusIcon(icon, 'working');
  const reading = readingName === null ? '' : `Reading ${readingName}. `;
  status.append(icon, el('span', 'secret-request-status-text', `${reading}${WAITING_TEXT}`));
  return status;
}

function failureBlock(failure: NonNullable<SecretRequestCard['failure']>): HTMLElement {
  const block = el('div', 'secret-request-failure');
  block.setAttribute('role', 'alert');
  block.append(el('p', 'secret-request-failure-text', failure.message));
  if (failure.detail === '') return block;
  const details = el('details', 'secret-request-details');
  details.append(el('summary', 'secret-request-details-summary', 'Show details'), el('pre', 'secret-request-details-text', failure.detail));
  block.append(details);
  return block;
}

function needsSourceBody(sessionId: string): HTMLElement[] {
  const actions = el('div', 'secret-request-actions');
  actions.append(
    button({ variant: 'secondary', label: 'Deny', onClick: () => sendChoice(sessionId, 'deny') }),
    linkButton({ variant: 'primary', label: 'Choose source', href: settingsHash(VAULT_SETTINGS_SECTION_ID) }),
  );
  return [el('p', 'secret-request-note', NEEDS_SOURCE_TEXT), actions];
}

function allowBody(sessionId: string, card: SecretRequestCard): HTMLElement[] {
  const body: HTMLElement[] = [];
  if (card.from !== null) body.push(labeledLine('From', `${namesText(card.names)} in ${card.from}`));
  body.push(labeledLine('Into', '.env.local in this worktree'));
  body.push(el('p', 'secret-request-note', 'Always allow skips this card for these names in this project. Your password manager may still ask you to confirm. Revoke it in Settings > Vault.'));
  if (card.phase === 'failed' && card.failure !== null) body.push(failureBlock(card.failure));
  const isReading = card.phase === 'reading';
  const footer = el('div', 'secret-request-footer');
  if (isReading) footer.append(waitingStatus(card.readingName));
  footer.append(choiceButtons(sessionId, isReading));
  body.push(footer);
  return body;
}

function buildRequest(sessionId: string, card: SecretRequestCard): HTMLElement {
  const request = el('div', 'secret-request');
  request.dataset.phase = card.phase;
  request.setAttribute('role', 'group');
  request.setAttribute('aria-label', 'Secret request');
  request.append(el('span', 'secret-request-title', `The agent wants to read ${namesText(card.names)}`));
  if (card.reason !== null) request.append(reasonBlock(card.reason));
  request.append(...(card.phase === 'needs-source' ? needsSourceBody(sessionId) : allowBody(sessionId, card)));
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
