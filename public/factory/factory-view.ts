import { FactoryQueueIntentRequest } from '#shared/contracts/factory.ts';
import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { FactoryState } from '#shared/contracts/factory.ts';
import { buildPanelSection, el } from '../dom-helpers.ts';
import { buildFactoryFloor, pickFactoryProject } from './factory-floor-core.ts';
import type { FactoryCrate, FactoryFloor, FactoryStation } from './factory-floor-core.ts';

let openTerminal: ((sessionId: string) => void) | null = null;
let root: HTMLDivElement | null = null;
let snapshot: FactoryState | null = null;
let isConnected = false;
let selectedProjectId: string | null = null;
let selectedOrderId: string | null = null;
let requestSender: ((message: Record<string, unknown>) => boolean) | null = null;
let requestSequence = 0;
type IntentDraft = Omit<FactoryQueueIntentRequest, 'projectId' | 'criteria' | 'writeScopes'> & { criteria: string; writeScopes: string };
type RequestStatus = { requestId: string | null; text: string; hasError: boolean };
const draftsByProject = new Map<string, IntentDraft>();
const queueStatusByProject = new Map<string, RequestStatus>();
const controlStatusByProject = new Map<string, RequestStatus>();

function intentDraft(projectId: string): IntentDraft {
  const previous = draftsByProject.get(projectId);
  if (previous) return previous;
  const draft: IntentDraft = { objective: '', criteria: '', risk: 'low', boundary: '', writeScopes: '' };
  draftsByProject.set(projectId, draft);
  return draft;
}

function buildRequestStatus(status: RequestStatus | undefined): HTMLElement {
  const element = el('p', 'factory-request-status', status?.text ?? '');
  element.setAttribute('role', 'status');
  element.dataset.error = String(status?.hasError === true);
  return element;
}

function sendFactoryRequest(projectId: string, type: 'factory-queue-intent' | 'factory-control', fields: Record<string, unknown>, statusText: string): void {
  const statuses = type === 'factory-queue-intent' ? queueStatusByProject : controlStatusByProject;
  if (statuses.get(projectId)?.requestId) return;
  requestSequence += 1;
  const requestId = `factory-${requestSequence}`;
  const sent = requestSender?.({ ...fields, projectId, type, requestId }) === true;
  statuses.set(projectId, { requestId: sent ? requestId : null, text: sent ? statusText : 'Not connected.', hasError: !sent });
  render();
}

function buildQueueForm(projectId: string): HTMLFormElement {
  const draft = intentDraft(projectId);
  const form = el('form', 'factory-queue-form');
  const isPending = queueStatusByProject.get(projectId)?.requestId != null;
  for (const [name, label, maxLength, rows] of [
    ['objective', 'Objective', 4096, 2], ['criteria', 'Criteria, one per line', 49164, 2],
    ['boundary', 'Authority boundary', 4096, 1], ['writeScopes', 'Write scopes, one per line', 32800, 2],
  ] as const) {
    const field = el('label', 'factory-form-field');
    const input = el('textarea', 'factory-form-input');
    input.name = name;
    input.dataset.factoryField = name;
    input.maxLength = maxLength;
    input.rows = rows;
    input.required = name !== 'writeScopes';
    input.value = draft[name];
    input.disabled = isPending;
    input.addEventListener('input', () => { draft[name] = input.value; });
    field.append(el('span', 'factory-label', label), input);
    form.append(field);
  }
  const riskField = el('label', 'factory-form-field');
  const risk = el('select', 'factory-form-input');
  risk.name = 'risk';
  risk.dataset.factoryField = 'risk';
  risk.disabled = isPending;
  for (const value of FactoryQueueIntentRequest.shape.risk.options) {
    const option = el('option', null, value);
    option.value = value;
    risk.append(option);
  }
  risk.value = draft.risk;
  risk.addEventListener('change', () => { draft.risk = FactoryQueueIntentRequest.shape.risk.parse(risk.value); });
  riskField.append(el('span', 'factory-label', 'Risk'), risk);
  const submit = el('button', 'factory-action', 'Queue intent');
  submit.type = 'submit';
  submit.disabled = !isConnected || isPending;
  form.insertBefore(riskField, form.children[2] ?? null);
  form.append(submit, buildRequestStatus(queueStatusByProject.get(projectId)));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = FactoryQueueIntentRequest.safeParse({
      ...draft, projectId,
      criteria: draft.criteria.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      writeScopes: draft.writeScopes.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    });
    if (!parsed.success) {
      queueStatusByProject.set(projectId, { requestId: null, text: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), hasError: true });
      render();
      return;
    }
    sendFactoryRequest(projectId, 'factory-queue-intent', parsed.data, 'Queueing intent.');
  });
  return form;
}

function buildFactoryControls(projectId: string, paused: boolean): HTMLElement {
  const controls = el('div', 'factory-controls');
  const status = controlStatusByProject.get(projectId);
  for (const action of ['pause', 'resume'] as const) {
    const button = el('button', 'factory-action', action === 'pause' ? 'Pause' : 'Resume');
    button.type = 'button';
    button.disabled = !isConnected || status?.requestId != null || (action === 'pause' ? paused : !paused);
    button.addEventListener('click', () => sendFactoryRequest(projectId, 'factory-control', { action }, action === 'pause' ? 'Pausing factory.' : 'Resuming factory.'));
    controls.append(button);
  }
  controls.append(buildRequestStatus(status));
  return controls;
}

const STATIONS: { id: FactoryStation; label: string; slots: number }[] = [
  { id: 'queue', label: 'Queue', slots: 3 },
  { id: 'workers', label: 'Workers', slots: 3 },
  { id: 'review', label: 'Review', slots: 2 },
  { id: 'watch', label: 'Watch', slots: 2 },
  { id: 'shipped', label: 'Shipped', slots: 3 },
];

function buildRegion(title: string, className: string): HTMLElement {
  const section = buildPanelSection('factory', title);
  section.classList.add(...className.split(' '));
  section.setAttribute('aria-label', title);
  return section;
}

function buildSprite(spriteClass: string, name: string): HTMLDivElement {
  const container = el('div', 'factory-sprite');
  container.setAttribute('role', 'img');
  container.setAttribute('aria-label', name);
  const sprite = el('span', `nyan-sprite ${spriteClass}`);
  sprite.setAttribute('aria-hidden', 'true');
  container.append(sprite);
  return container;
}

function selectOrder(orderId: string): void {
  selectedOrderId = orderId;
  render();
}

function buildOrderSelector(id: string, objective: string, className: string): HTMLButtonElement {
  const button = el('button', className, objective);
  button.type = 'button';
  button.dataset.orderId = id;
  button.setAttribute('aria-pressed', String(selectedOrderId === id));
  button.addEventListener('click', () => selectOrder(id));
  return button;
}

function buildCrate(crate: FactoryCrate): HTMLElement {
  const container = el('div', 'factory-crate');
  container.dataset.state = crate.isHeld ? 'waiting' : crate.station;
  container.dataset.selected = String(crate.isSelected);
  const identity = el('div', 'factory-crate-id');
  const risk = el('span', 'factory-crate-risk', crate.risk);
  risk.dataset.risk = crate.risk;
  identity.append(el('span', null, crate.id), risk);
  container.append(identity, buildOrderSelector(crate.id, crate.objective, 'factory-crate-title'));
  if (crate.sessionId && openTerminal) {
    const sessionId = crate.sessionId;
    const terminalButton = el('button', 'factory-action', 'Open terminal');
    terminalButton.type = 'button';
    terminalButton.addEventListener('click', () => openTerminal?.(sessionId));
    container.append(terminalButton);
  }
  if (crate.station !== 'workers') container.append(el('span', 'factory-crate-note', crate.status));
  return container;
}

function buildTop(floor: FactoryFloor, projectId: string): HTMLElement {
  const band = el('div', 'factory-band factory-head');
  const intent = buildRegion('Intent', 'factory-intent');
  intent.append(el('p', 'factory-count', floor.spend));
  if (floor.intent) {
    intent.append(buildOrderSelector(floor.intent.id, floor.intent.objective, 'factory-intent-title'));
    const criteria = el('ul', 'factory-criteria');
    for (const criterion of floor.intent.criteria) {
      const line = el('li', null, `${criterion.isMet ? '[x]' : '[ ]'} ${criterion.text}`);
      line.dataset.met = String(criterion.isMet);
      criteria.append(line);
    }
    intent.append(criteria, el('p', 'factory-count', `${floor.intent.shippedCount} of ${floor.intent.childCount} shipped`));
  }
  if (!floor.intent) intent.append(el('p', 'factory-empty', 'No open intent.'));
  const orchestrator = buildRegion('Orchestrator', 'factory-orchestrator');
  orchestrator.dataset.state = floor.orchestrator.isException ? 'failed' : floor.paused ? 'paused' : 'steady';
  const heading = el('div', 'factory-heading');
  heading.append(el('strong', 'factory-orchestrator-action', floor.orchestrator.action), el('p', 'factory-reason', floor.orchestrator.reason));
  if (floor.note) heading.append(el('p', 'factory-reason', floor.note));
  const pausedMarker = el('span', 'factory-paused-marker', '[paused]');
  pausedMarker.hidden = !floor.paused;
  heading.append(pausedMarker, buildFactoryControls(projectId, floor.paused));
  const owl = buildSprite('is-owl', 'Orchestrator owl');
  const sessionId = floor.orchestrator.sessionId;
  if (sessionId && openTerminal) {
    const terminalButton = el('button', 'factory-action');
    terminalButton.type = 'button';
    terminalButton.setAttribute('aria-label', 'Open orchestrator terminal');
    terminalButton.append(owl);
    terminalButton.addEventListener('click', () => openTerminal?.(sessionId));
    orchestrator.append(terminalButton);
  }
  if (!sessionId || !openTerminal) orchestrator.append(owl);
  if (floor.orchestrator.state) heading.append(el('span', 'factory-orchestrator-state', floor.orchestrator.state));
  orchestrator.append(heading);
  const upNext = buildRegion('Up next', 'factory-up-next');
  const intents = el('ol', 'factory-intent-queue');
  for (const order of floor.upNext) {
    const line = el('li');
    line.append(buildOrderSelector(order.id, order.objective, 'factory-next-title'));
    intents.append(line);
  }
  upNext.append(intents);
  if (floor.upNext.length === 0) upNext.append(el('p', 'factory-empty', 'No queued intents.'));
  upNext.append(buildQueueForm(projectId));
  band.append(intent, orchestrator, upNext);
  return band;
}

function buildStation(station: (typeof STATIONS)[number], crates: FactoryCrate[]): HTMLElement {
  const section = el('section', `factory-station factory-station-${station.id}`);
  section.setAttribute('aria-label', station.label);
  const head = el('div', 'factory-station-head');
  head.append(el('h3', 'factory-label', station.label), el('span', 'factory-count', String(crates.length)));
  const slots = el('div', station.id === 'workers' ? 'factory-pads' : 'factory-stack');
  for (let slotIndex = 0; slotIndex < Math.max(station.slots, crates.length); slotIndex += 1) {
    const crate = crates[slotIndex];
    const emptySlot = el('div', 'factory-open', 'Open slot');
    if (station.id !== 'workers') {
      slots.append(crate ? buildCrate(crate) : emptySlot);
      continue;
    }
    const pad = el('div', 'factory-pad');
    pad.dataset.state = crate?.hasConflict ? 'waiting' : crate ? 'running' : 'idle';
    if (crate) pad.append(buildSprite(crate.animal.sprite, crate.animal.name));
    if (!crate) pad.append(el('div', 'factory-sprite factory-sprite-empty'));
    pad.append(crate ? buildCrate(crate) : emptySlot, el('span', 'factory-pad-status', crate?.status ?? 'Idle'));
    slots.append(pad);
  }
  section.append(head, slots);
  return section;
}

function formatLedgerClock(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return isoTimestamp;
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildBottom(floor: FactoryFloor): HTMLElement {
  const band = el('div', 'factory-band factory-foot');
  const ledger = buildRegion('Ledger', 'factory-ledger-region');
  const lines = el('ol', 'factory-ledger');
  for (const event of floor.ledger) {
    const line = el('li');
    const time = el('time', 'factory-ledger-time', formatLedgerClock(event.at));
    time.dateTime = event.at;
    line.append(time, el('span', null, `${event.orderId} ${event.event} (${event.session})`));
    lines.append(line);
  }
  if (floor.ledger.length === 0) lines.append(el('li', 'factory-empty', 'No ledger events.'));
  ledger.append(lines);
  const detail = buildRegion('Selected order', 'factory-detail-region');
  const body = el('div', 'factory-detail');
  const order = floor.selectedOrder;
  if (order) {
    const fields = el('dl');
    for (const [label, value] of [
      ['Intent', order.intent ?? 'No parent intent'],
      ['Fence', order.writeScopes.join(', ') || 'None'],
      ['After', order.dependsOn.join(', ') || 'None'],
      ['Station', order.station],
      ['Session', order.owner ?? 'Unassigned'],
    ]) fields.append(el('dt', null, label), el('dd', null, value));
    body.append(fields);
  }
  if (!order) body.append(el('p', 'factory-empty', 'Select an order to inspect its boundaries.'));
  detail.append(body);
  band.append(ledger, el('div', 'factory-seam'), detail);
  return band;
}

function render(): void {
  if (!root) return;
  const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusedOrderId = focusedElement?.dataset.orderId;
  const focusedProjectId = focusedElement?.dataset.projectId;
  const focusedFactoryField = focusedElement?.dataset.factoryField;
  const selection = focusedElement instanceof HTMLTextAreaElement ? { start: focusedElement.selectionStart, end: focusedElement.selectionEnd } : null;
  const scrollPositions = [...root.querySelectorAll<HTMLElement>('.factory-stack, .factory-pads, .factory-ledger, .factory-detail, .factory-intent-queue, .factory-criteria')].map((element) => element.scrollTop);
  const content = document.createDocumentFragment();
  const connection = el('p', 'factory-connection', isConnected ? snapshot ? '' : 'Waiting for the server.' : 'Disconnected. Showing the last snapshot.');
  connection.setAttribute('role', 'status');
  content.append(connection);
  const project = pickFactoryProject(snapshot?.projects ?? [], selectedProjectId);
  if (!project) {
    content.append(el('p', 'factory-empty', snapshot ? 'No repos holding coherence.config.json.' : 'Waiting for Factory state.'));
    root.replaceChildren(content);
    return;
  }
  if (selectedProjectId !== project.projectId) selectedOrderId = null;
  selectedProjectId = project.projectId;
  if (snapshot && snapshot.projects.length > 1) {
    const chips = el('div', 'factory-projects');
    chips.setAttribute('aria-label', 'Factory projects');
    for (const candidate of snapshot.projects) {
      const chip = el('button', 'factory-project', candidate.projectName);
      chip.type = 'button';
      chip.dataset.projectId = candidate.projectId;
      chip.setAttribute('aria-pressed', String(candidate.projectId === selectedProjectId));
      chip.addEventListener('click', () => {
        selectedProjectId = candidate.projectId;
        selectedOrderId = null;
        render();
      });
      chips.append(chip);
    }
    content.append(chips);
  }
  const floor = buildFactoryFloor(project, selectedOrderId);
  const bands = el('div', 'factory-console');
  const floorBand = buildRegion('Floor', 'factory-band factory-floor-band');
  const pipe = el('div', 'factory-pipe');
  for (const station of STATIONS) pipe.append(buildStation(station, floor.stations[station.id]));
  floorBand.append(pipe);
  bands.append(buildTop(floor, project.projectId), floorBand, buildBottom(floor));
  content.append(bands);
  root.replaceChildren(content);
  [...root.querySelectorAll<HTMLElement>('.factory-stack, .factory-pads, .factory-ledger, .factory-detail, .factory-intent-queue, .factory-criteria')].forEach((element, index) => { element.scrollTop = scrollPositions[index] ?? 0; });
  if (focusedOrderId) [...root.querySelectorAll<HTMLElement>('[data-order-id]')].find((element) => element.dataset.orderId === focusedOrderId)?.focus({ preventScroll: true });
  if (focusedFactoryField) {
    const input = [...root.querySelectorAll<HTMLElement>('[data-factory-field]')].find((element) => element.dataset.factoryField === focusedFactoryField);
    input?.focus({ preventScroll: true });
    if (input instanceof HTMLTextAreaElement && selection) input.setSelectionRange(selection.start, selection.end);
  }
  if (focusedProjectId) [...root.querySelectorAll<HTMLElement>('[data-project-id]')].find((element) => element.dataset.projectId === focusedProjectId)?.focus({ preventScroll: true });
}

export function mountFactoryView(parent: HTMLElement, navigation?: { openTerminal: (sessionId: string) => void }): HTMLDivElement {
  openTerminal = navigation?.openTerminal ?? null;
  if (root) return root;
  root = el('div', 'factory-content');
  parent.append(root);
  render();
  return root;
}

export function applyFactoryState(message: FactoryState): void {
  snapshot = message;
  render();
}

export function applyFactoryConnectionState(connected: boolean): void {
  isConnected = connected;
  if (!connected) {
    for (const statuses of [queueStatusByProject, controlStatusByProject]) {
      for (const [projectId, status] of statuses) {
        if (!status.requestId) continue;
        statuses.set(projectId, { requestId: null, text: 'Disconnected. Check the floor before submitting again.', hasError: true });
      }
    }
  }
  render();
}

export function setFactoryRequestSender(sender: (message: Record<string, unknown>) => boolean): void {
  requestSender = sender;
}

export function applyFactoryQueueIntentResult(message: ServerMessageOf<'factory-queue-intent-result'>): void {
  if (queueStatusByProject.get(message.projectId)?.requestId !== message.requestId) return;
  queueStatusByProject.set(message.projectId, {
    requestId: null, text: message.ok ? `Queued ${message.workId ?? 'intent'}.` : message.error ?? 'Could not queue intent.', hasError: !message.ok,
  });
  if (message.ok) draftsByProject.delete(message.projectId);
  render();
}

export function applyFactoryControlResult(message: ServerMessageOf<'factory-control-result'>): void {
  if (controlStatusByProject.get(message.projectId)?.requestId !== message.requestId) return;
  controlStatusByProject.set(message.projectId, {
    requestId: null, text: message.ok ? message.action === 'pause' ? 'Factory paused.' : 'Factory resumed.' : message.error ?? 'Could not update factory.', hasError: !message.ok,
  });
  render();
}
