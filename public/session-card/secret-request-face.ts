import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { sessionUIs } from './card-registry.ts';
import './secret-request-face.css';

const namesBySessionId = new Map<string, string[]>();
const requestElementBySessionId = new Map<string, HTMLElement>();

const REFERENCE_PLACEHOLDER = 'op://vault/item/field';

function sendDecision(sessionId: string, isAllowed: boolean, referenceInputs: ReadonlyMap<string, HTMLInputElement>) {
  const referenceByName = Object.fromEntries([...referenceInputs].map(([name, input]) => [name, input.value.trim()]).filter(([, reference]) => reference));
  sendControlMsg({ type: 'secret-decision', id: sessionId, isAllowed, referenceByName });
}

function buildRequest(sessionId: string, names: readonly string[]): HTMLElement {
  const request = el('div', 'secret-request');
  request.setAttribute('role', 'group');
  request.setAttribute('aria-label', 'Secret request');
  const referenceInputs = new Map<string, HTMLInputElement>();
  const rows = el('div', 'secret-request-rows');
  for (const name of names) {
    const input = el('input', 'dialog-input secret-request-reference');
    input.type = 'text';
    input.placeholder = REFERENCE_PLACEHOLDER;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `Vault reference for ${name}`);
    referenceInputs.set(name, input);
    const row = el('label', 'secret-request-row');
    row.append(el('code', 'secret-request-name', name), input);
    rows.append(row);
  }
  const actions = el('div', 'secret-request-actions');
  actions.append(
    button({ variant: 'secondary', label: 'Deny', onClick: () => sendDecision(sessionId, false, referenceInputs) }),
    button({ variant: 'primary', label: 'Allow', onClick: () => sendDecision(sessionId, true, referenceInputs) }),
  );
  request.append(el('span', 'secret-request-text', 'The agent asks for these secrets. Allow saves each vault reference for this project.'), rows, actions);
  return request;
}

function paintSecretRequest(sessionId: string) {
  requestElementBySessionId.get(sessionId)?.remove();
  requestElementBySessionId.delete(sessionId);
  const names = namesBySessionId.get(sessionId);
  const ui = sessionUIs.get(sessionId);
  if (!names || !ui) return;
  const request = buildRequest(sessionId, names);
  requestElementBySessionId.set(sessionId, request);
  ui.termWrap.append(request);
}

function setRequestNames(sessionId: string, names: readonly string[]) {
  if (names.length === 0) {
    namesBySessionId.delete(sessionId);
    return;
  }
  namesBySessionId.set(sessionId, [...names]);
}

function applySecretRequest(message: ServerMessageOf<'session-secret-request'>) {
  setRequestNames(message.id, message.names);
  paintSecretRequest(message.id);
}

function applySecretRequestsSnapshot(message: ServerMessageOf<'secret-requests-snapshot'>) {
  const previousSessionIds = [...namesBySessionId.keys()];
  namesBySessionId.clear();
  for (const [sessionId, names] of Object.entries(message.requests)) setRequestNames(sessionId, names);
  for (const sessionId of new Set([...previousSessionIds, ...namesBySessionId.keys()])) paintSecretRequest(sessionId);
}

export { applySecretRequest, applySecretRequestsSnapshot, paintSecretRequest };
