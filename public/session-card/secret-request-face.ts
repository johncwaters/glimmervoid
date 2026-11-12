import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { sessionUIs } from './card-registry.ts';
import './secret-request-face.css';

const namesBySessionId = new Map<string, string[]>();
const requestElementBySessionId = new Map<string, HTMLElement>();
const vaultInputBySessionId = new Map<string, HTMLInputElement>();
let companionNewItemsVault: string | null = null;

const REFERENCE_PLACEHOLDER = 'op://vault/item/field';
const VALUE_PLACEHOLDER = 'or paste the value';

interface RequestInputs {
  referenceByName: Map<string, HTMLInputElement>;
  valueByName: Map<string, HTMLInputElement>;
  vault: HTMLInputElement;
}

function filledValues(inputs: ReadonlyMap<string, HTMLInputElement>, readValue: (input: HTMLInputElement) => string): Record<string, string> {
  return Object.fromEntries([...inputs].map(([name, input]) => [name, readValue(input)]).filter(([, value]) => value));
}

function sendDecision(sessionId: string, isAllowed: boolean, inputs: RequestInputs) {
  if (!isAllowed) {
    sendControlMsg({ type: 'secret-decision', id: sessionId, isAllowed });
    return;
  }
  sendControlMsg({
    type: 'secret-decision',
    id: sessionId,
    isAllowed,
    referenceByName: filledValues(inputs.referenceByName, (input) => input.value.trim()),
    valueByName: filledValues(inputs.valueByName, (input) => input.value),
    newItemsVault: inputs.vault.value.trim(),
  });
}

function vaultPlaceholder(): string {
  return companionNewItemsVault ?? 'vault name';
}

function textInput(className: string, placeholder: string, label: string): HTMLInputElement {
  const input = el('input', `dialog-input ${className}`);
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', label);
  return input;
}

function buildRequest(sessionId: string, names: readonly string[]): HTMLElement {
  const request = el('div', 'secret-request');
  request.setAttribute('role', 'group');
  request.setAttribute('aria-label', 'Secret request');
  const inputs: RequestInputs = { referenceByName: new Map(), valueByName: new Map(), vault: textInput('secret-request-vault', vaultPlaceholder(), 'Vault for pasted values') };
  vaultInputBySessionId.set(sessionId, inputs.vault);
  const rows = el('div', 'secret-request-rows');
  for (const name of names) {
    const referenceInput = textInput('secret-request-reference', REFERENCE_PLACEHOLDER, `Vault reference for ${name}`);
    const valueInput = textInput('secret-request-value', VALUE_PLACEHOLDER, `Value for ${name}, saved into the vault`);
    valueInput.type = 'password';
    valueInput.autocomplete = 'new-password';
    inputs.referenceByName.set(name, referenceInput);
    inputs.valueByName.set(name, valueInput);
    const row = el('div', 'secret-request-row');
    row.append(el('code', 'secret-request-name', name), referenceInput, valueInput);
    rows.append(row);
  }
  const vaultRow = el('label', 'secret-request-vault-row');
  vaultRow.append(el('span', 'secret-request-vault-label', 'Pasted values go into'), inputs.vault);
  const actions = el('div', 'secret-request-actions');
  actions.append(
    button({ variant: 'secondary', label: 'Deny', onClick: () => sendDecision(sessionId, false, inputs) }),
    button({ variant: 'primary', label: 'Allow', onClick: () => sendDecision(sessionId, true, inputs) }),
  );
  request.append(el('span', 'secret-request-text', 'The agent asks for these secrets. Allow saves each vault reference for this project; a pasted value goes into the vault first.'), rows, vaultRow, actions);
  return request;
}

function setCompanionNewItemsVault(newItemsVault: string | null) {
  companionNewItemsVault = newItemsVault;
  for (const input of vaultInputBySessionId.values()) input.placeholder = vaultPlaceholder();
}

function hasSameRequest(sessionId: string): boolean {
  const painted = requestElementBySessionId.get(sessionId);
  const names = namesBySessionId.get(sessionId);
  return painted !== undefined && names !== undefined && painted.dataset.names === names.join(' ');
}

function paintSecretRequest(sessionId: string) {
  const ui = sessionUIs.get(sessionId);
  if (ui && hasSameRequest(sessionId) && requestElementBySessionId.get(sessionId)?.parentElement === ui.card) return;
  requestElementBySessionId.get(sessionId)?.remove();
  requestElementBySessionId.delete(sessionId);
  vaultInputBySessionId.delete(sessionId);
  const names = namesBySessionId.get(sessionId);
  if (!names || !ui) return;
  const request = buildRequest(sessionId, names);
  request.dataset.names = names.join(' ');
  requestElementBySessionId.set(sessionId, request);
  ui.termWrap.before(request);
}

function setRequestNames(sessionId: string, names: readonly string[]) {
  if (names.length === 0) {
    namesBySessionId.delete(sessionId);
    return;
  }
  namesBySessionId.set(sessionId, [...names]);
}

function applySecretRequest(message: ServerMessageOf<'session-secret-request'>) {
  setCompanionNewItemsVault(message.newItemsVault);
  setRequestNames(message.id, message.names);
  paintSecretRequest(message.id);
}

function applySecretRequestsSnapshot(message: ServerMessageOf<'secret-requests-snapshot'>) {
  setCompanionNewItemsVault(message.newItemsVault);
  const previousSessionIds = [...namesBySessionId.keys()];
  namesBySessionId.clear();
  for (const [sessionId, names] of Object.entries(message.requests)) setRequestNames(sessionId, names);
  for (const sessionId of new Set([...previousSessionIds, ...namesBySessionId.keys()])) paintSecretRequest(sessionId);
}

export { applySecretRequest, applySecretRequestsSnapshot, paintSecretRequest };
