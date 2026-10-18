import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { FactoryControlRequest, FactoryProjectState, FactoryState } from '#shared/contracts/factory.ts';
import { localClockText } from '#shared/display-text.ts';
import { buildCoherenceAdoptControl, listAdoptableCoherenceProjects } from '../coherence/adopt-action.ts';
import { buildProjectCoherenceChip, findTrendedCoherenceProjectId } from '../coherence/trend-chip.ts';
import { buildPanelSection, el } from '../dom-helpers.ts';
import { basename } from '../focus-view/roster-groups-core.ts';
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
type RequestStatus = { requestId: string | null; text: string; hasError: boolean; target?: string };
const controlStatusByProject = new Map<string, RequestStatus>();
let isAdoptListOpen = false;

const SCROLLABLE_REGIONS_SELECTOR = '.factory-stack, .factory-pads, .factory-ledger, .factory-detail, .factory-intent-queue, .factory-criteria, .factory-digests';
const FOCUS_RESTORE_TARGETS = [['[data-order-id]', 'orderId'], ['[data-factory-field]', 'factoryField'], ['[data-project-id]', 'projectId']] as const;

function buildButton(className: string, label: string | null, onClick: () => void): HTMLButtonElement {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function buildRequestStatus(status: RequestStatus | undefined): HTMLElement {
  const element = el('p', 'factory-request-status', status?.text ?? '');
  element.setAttribute('role', 'status');
  element.dataset.error = String(status?.hasError === true);
  return element;
}

function sendFactoryControl(projectId: string, fields: { action: FactoryControlRequest['action']; intentId?: string }, statusText: string): void {
  if (controlStatusByProject.get(projectId)?.requestId) return;
  requestSequence += 1;
  const requestId = `factory-${requestSequence}`;
  const sent = requestSender?.({ ...fields, projectId, type: 'factory-control', requestId }) === true;
  controlStatusByProject.set(projectId, { requestId: sent ? requestId : null, text: sent ? statusText : 'Not connected.', hasError: !sent, target: fields.intentId ?? fields.action });
  render();
}

function buildFactoryControls(projectId: string, paused: boolean): HTMLElement {
  const controls = el('div', 'factory-controls');
  const status = controlStatusByProject.get(projectId);
  for (const action of ['pause', 'resume'] as const) {
    const button = buildButton('factory-action', action === 'pause' ? 'Pause' : 'Resume',
      () => sendFactoryControl(projectId, { action }, action === 'pause' ? 'Pausing factory.' : 'Resuming factory.'));
    button.disabled = !isConnected || status?.requestId != null || (action === 'pause' ? paused : !paused);
    controls.append(button);
  }
  controls.append(buildRequestStatus(status?.target === 'pause' || status?.target === 'resume' ? status : undefined));
  return controls;
}

function buildProjectProfile(project: FactoryProjectState): HTMLElement {
  const section = buildRegion('Project profile', 'factory-band factory-profile');
  const fields = el('dl', 'factory-profile-fields');
  const profile = project.factoryProfile;
  for (const [label, value] of [
    ['Checks', profile?.checks?.join('\n') ?? 'not set'],
    ['Focused test command', profile?.focusedTestCommand ?? 'not set'],
    ['Widenable scopes', profile?.widenableScopes?.join('\n') ?? 'not set'],
  ]) fields.append(el('dt', 'factory-label', label), el('dd', null, value || 'None'));
  section.append(fields);
  if (project.observedRun) return section;
  const status = controlStatusByProject.get(project.projectId);
  const controls = el('div', 'factory-controls');
  const button = buildButton('factory-action', 'Re-run setup', () => sendFactoryControl(project.projectId, { action: 'rerun-setup' }, 'Running project setup.'));
  button.dataset.factoryField = 'rerun-setup';
  button.disabled = !isConnected || status?.requestId != null;
  controls.append(button, buildRequestStatus(status?.target === 'rerun-setup' ? status : undefined));
  section.append(controls);
  return section;
}

function buildIntentDigests(floor: FactoryFloor, project: FactoryProjectState): HTMLElement {
  const section = buildRegion('Intent digests', 'factory-band factory-digest-region');
  const digests = el('div', 'factory-digests');
  const status = controlStatusByProject.get(project.projectId);
  for (const digest of floor.digests) {
    const intent = el('article', 'factory-digest');
    intent.append(el('h3', 'factory-digest-title', digest.objective), el('p', 'factory-count', `${digest.intentId}: ${digest.isPartial ? 'Partial' : 'Completed'}. ${digest.merged.length} merged, ${digest.parked.length} parked.`));
    const merged = el('ul', 'factory-digest-list factory-digest-merged');
    for (const ticket of digest.merged) {
      const row = el('li', null, `${ticket.id}: ${ticket.objective}`);
      row.title = ticket.objective;
      merged.append(row);
    }
    intent.append(el('h4', 'factory-label', 'Merged tickets'), merged);
    const parked = el('ul', 'factory-digest-list');
    for (const ticket of digest.parked) {
      const line = el('li');
      line.append(el('span', null, `${ticket.id}: ${ticket.objective}`), el('p', 'factory-parked-need', ticket.need ?? 'Need not recorded.'));
      parked.append(line);
    }
    intent.append(el('h4', 'factory-label', 'Parked tickets'), parked);
    const flakes = el('ul', 'factory-digest-list');
    for (const flake of digest.confirmedFlakes) flakes.append(el('li', null, flake));
    if (digest.confirmedFlakes.length === 0) flakes.append(el('li', 'factory-empty', 'None'));
    intent.append(el('h4', 'factory-label', 'Confirmed flakes'), flakes);
    if (digest.isPartial && !project.observedRun) {
      const controls = el('div', 'factory-controls');
      const button = buildButton('factory-action', 'Retry parked', () => sendFactoryControl(project.projectId, { action: 'retry-parked', intentId: digest.intentId }, 'Reopening parked tickets.'));
      button.dataset.factoryField = `retry-parked:${digest.intentId}`;
      button.disabled = !isConnected || status?.requestId != null;
      controls.append(button, buildRequestStatus(status?.target === digest.intentId ? status : undefined));
      intent.append(controls);
    }
    digests.append(intent);
  }
  if (floor.digests.length === 0) digests.append(el('p', 'factory-empty', 'No finished intents.'));
  section.append(el('p', 'factory-count', floor.spend), digests);
  if (status?.target && !['pause', 'resume', 'rerun-setup'].includes(status.target) && !floor.digests.some((digest) => digest.isPartial && digest.intentId === status.target)) {
    section.append(buildRequestStatus(status));
  }
  return section;
}

const STATIONS: { id: FactoryStation; label: string; slots: number }[] = [
  { id: 'queue', label: 'Queue', slots: 3 },
  { id: 'workers', label: 'Workers', slots: 3 },
  { id: 'review', label: 'Review', slots: 2 },
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
  const button = buildButton(className, objective, () => selectOrder(id));
  button.dataset.orderId = id;
  button.setAttribute('aria-pressed', String(selectedOrderId === id));
  return button;
}

function buildCrate(crate: FactoryCrate, isReadOnly: boolean): HTMLElement {
  const container = el('div', 'factory-crate');
  container.dataset.state = crate.isHeld ? 'waiting' : crate.station;
  container.dataset.selected = String(crate.isSelected);
  const identity = el('div', 'factory-crate-id');
  const risk = el('span', 'factory-crate-risk', crate.risk);
  risk.dataset.risk = crate.risk;
  identity.append(el('span', null, crate.id), risk);
  container.append(identity, buildOrderSelector(crate.id, crate.objective, 'factory-crate-title'));
  const sessionId = crate.sessionId;
  if (sessionId && openTerminal && !isReadOnly) container.append(buildButton('factory-action', 'Open terminal', () => openTerminal?.(sessionId)));
  if (crate.station !== 'workers') container.append(el('span', 'factory-crate-note', crate.status));
  return container;
}

function describeObservedRun(observedRun: NonNullable<FactoryProjectState['observedRun']>): string {
  return `Read-only mirror of the factory harness run at ${observedRun.recordDirectory}. ${observedRun.outcome ? `Ended: ${observedRun.outcome}.` : 'No verdict yet.'}`;
}

function buildTop(floor: FactoryFloor, project: FactoryProjectState): HTMLElement {
  const projectId = project.projectId;
  const isReadOnly = project.observedRun !== undefined;
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
  heading.append(pausedMarker);
  if (project.observedRun) heading.append(el('p', 'factory-reason', describeObservedRun(project.observedRun)));
  if (!isReadOnly) heading.append(buildFactoryControls(projectId, floor.paused));
  const owl = buildSprite('is-owl', 'Orchestrator owl');
  const sessionId = floor.orchestrator.sessionId;
  if (sessionId && openTerminal && !isReadOnly) {
    const terminalButton = buildButton('factory-action', null, () => openTerminal?.(sessionId));
    terminalButton.setAttribute('aria-label', 'Open orchestrator terminal');
    terminalButton.append(owl);
    orchestrator.append(terminalButton);
  }
  if (!sessionId || !openTerminal || isReadOnly) orchestrator.append(owl);
  if (floor.orchestrator.stateLabel) heading.append(el('span', 'factory-orchestrator-state', floor.orchestrator.stateLabel));
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
  band.append(intent, orchestrator, upNext);
  return band;
}

function buildStation(station: (typeof STATIONS)[number], crates: FactoryCrate[], isReadOnly: boolean): HTMLElement {
  const section = el('section', `factory-station factory-station-${station.id}`);
  section.setAttribute('aria-label', station.label);
  const head = el('div', 'factory-station-head');
  head.append(el('h3', 'factory-label', station.label), el('span', 'factory-count', String(crates.length)));
  const slots = el('div', station.id === 'workers' ? 'factory-pads' : 'factory-stack');
  for (let slotIndex = 0; slotIndex < Math.max(station.slots, crates.length); slotIndex += 1) {
    const crate = crates[slotIndex];
    const emptySlot = el('div', 'factory-open', 'Open slot');
    if (station.id !== 'workers') {
      slots.append(crate ? buildCrate(crate, isReadOnly) : emptySlot);
      continue;
    }
    const pad = el('div', 'factory-pad');
    pad.dataset.state = crate?.hasConflict ? 'waiting' : crate ? 'running' : 'idle';
    if (crate) pad.append(buildSprite(crate.animal.sprite, crate.animal.name));
    if (!crate) pad.append(el('div', 'factory-sprite factory-sprite-empty'));
    pad.append(crate ? buildCrate(crate, isReadOnly) : emptySlot, el('span', 'factory-pad-status', crate?.status ?? 'Idle'));
    slots.append(pad);
  }
  section.append(head, slots);
  return section;
}

function formatLedgerClock(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return isoTimestamp;
  return localClockText(parsed);
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
  const detail = buildRegion('Selected ticket', 'factory-detail-region');
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
  if (!order) body.append(el('p', 'factory-empty', 'Select a ticket to inspect its boundaries.'));
  detail.append(body);
  band.append(ledger, el('div', 'factory-seam'), detail);
  return band;
}

function selectProject(projectId: string): void {
  selectedProjectId = projectId;
  selectedOrderId = null;
  render();
}

function buildProjectSwitcher(project: FactoryProjectState): HTMLElement {
  const projects = snapshot?.projects ?? [];
  if (projects.length < 2) return el('h2', 'factory-project-name', project.projectName);
  const chips = el('div', 'factory-projects');
  chips.setAttribute('aria-label', 'Factory projects');
  for (const candidate of projects) {
    const chip = buildButton('factory-project', candidate.projectName, () => selectProject(candidate.projectId));
    chip.dataset.projectId = candidate.projectId;
    chip.setAttribute('aria-pressed', String(candidate.projectId === project.projectId));
    chips.append(chip);
  }
  return chips;
}

function buildMasthead(project: FactoryProjectState): HTMLElement {
  const masthead = el('div', 'factory-masthead');
  masthead.append(buildProjectSwitcher(project));
  const coherenceProjectId = findTrendedCoherenceProjectId(project.projectPath);
  if (coherenceProjectId) masthead.append(buildProjectCoherenceChip(coherenceProjectId));
  return masthead;
}

function buildAdoptList(): HTMLElement {
  const adoptableProjects = listAdoptableCoherenceProjects();
  const disclosure = el('details', 'factory-adopt');
  disclosure.hidden = adoptableProjects.length === 0;
  disclosure.open = isAdoptListOpen;
  disclosure.addEventListener('toggle', () => { isAdoptListOpen = disclosure.open; });
  disclosure.append(el('summary', 'factory-label factory-adopt-summary', 'Projects without Coherence'));
  for (const adoptableProject of adoptableProjects) {
    const line = el('div', 'factory-adopt-line');
    line.title = adoptableProject.path;
    line.append(el('span', null, basename(adoptableProject.path)), buildCoherenceAdoptControl(adoptableProject.projectId));
    disclosure.append(line);
  }
  return disclosure;
}

export function refreshFactoryCoherenceTrends() {
  if (!root) return;
  root.querySelector('.factory-adopt')?.replaceWith(buildAdoptList());
  const project = pickFactoryProject(snapshot?.projects ?? [], selectedProjectId);
  if (project) root.querySelector('.factory-masthead')?.replaceWith(buildMasthead(project));
}

function render(): void {
  if (!root) return;
  const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const scrollPositions = [...root.querySelectorAll<HTMLElement>(SCROLLABLE_REGIONS_SELECTOR)].map((element) => element.scrollTop);
  const content = document.createDocumentFragment();
  const connection = el('p', 'factory-connection', isConnected ? snapshot ? '' : 'Waiting for the server.' : 'Disconnected. Showing the last snapshot.');
  connection.setAttribute('role', 'status');
  content.append(connection);
  const project = pickFactoryProject(snapshot?.projects ?? [], selectedProjectId);
  if (!project) {
    content.append(el('p', 'factory-empty', snapshot ? 'No repos holding coherence.config.json.' : 'Waiting for Factory state.'), buildAdoptList());
    root.replaceChildren(content);
    return;
  }
  if (selectedProjectId !== project.projectId) selectedOrderId = null;
  selectedProjectId = project.projectId;
  const floor = buildFactoryFloor(project, selectedOrderId);
  const bands = el('div', 'factory-console');
  const floorBand = buildRegion('Floor', 'factory-band factory-floor-band');
  const pipe = el('div', 'factory-pipe');
  for (const station of STATIONS) pipe.append(buildStation(station, floor.stations[station.id], project.observedRun !== undefined));
  floorBand.append(pipe);
  bands.append(buildTop(floor, project), floorBand, buildBottom(floor), buildIntentDigests(floor, project), buildProjectProfile(project));
  content.append(buildMasthead(project), bands, buildAdoptList());
  root.replaceChildren(content);
  [...root.querySelectorAll<HTMLElement>(SCROLLABLE_REGIONS_SELECTOR)].forEach((element, index) => { element.scrollTop = scrollPositions[index] ?? 0; });
  for (const [selector, datasetKey] of FOCUS_RESTORE_TARGETS) {
    const focusedValue = focusedElement?.dataset[datasetKey];
    if (!focusedValue) continue;
    [...root.querySelectorAll<HTMLElement>(selector)].find((element) => element.dataset[datasetKey] === focusedValue)?.focus({ preventScroll: true });
  }
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
    for (const [projectId, status] of controlStatusByProject) {
      if (!status.requestId) continue;
      controlStatusByProject.set(projectId, { ...status, requestId: null, text: 'Disconnected. Check the floor before submitting again.', hasError: true });
    }
  }
  render();
}

export function setFactoryRequestSender(sender: (message: Record<string, unknown>) => boolean): void {
  requestSender = sender;
}

export function applyFactoryControlResult(message: ServerMessageOf<'factory-control-result'>): void {
  if (controlStatusByProject.get(message.projectId)?.requestId !== message.requestId) return;
  const successText = {
    pause: 'Factory paused.', resume: 'Factory resumed.', 'rerun-setup': 'Project setup finished.',
    'retry-parked': `Reopened ${message.reopenedWorkIds?.length ?? 0} parked tickets.`,
  };
  controlStatusByProject.set(message.projectId, {
    ...controlStatusByProject.get(message.projectId),
    requestId: null, text: message.ok ? successText[message.action] : message.error ?? 'Could not update factory.', hasError: !message.ok,
  });
  render();
}
