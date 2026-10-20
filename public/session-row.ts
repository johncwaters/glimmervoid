import { el, query, stateChip } from './dom-helpers.ts';
import { describeOwnership } from './focus-view/attention-core.ts';
import { paintCardOwnership, remoteWorkspaceHoverText } from './session-card/card-dom.ts';
import { sessionName, sessionUIs } from './session-card/card-registry.ts';
import { paintStatusIcon } from './status-icon.ts';
import type { SessionUi } from './session-card/card-registry.ts';
import { sessionElapsedText } from './session-card/session-tick.ts';
import { SIGNAL_TIER } from './signal-core.ts';
import type { Signal } from './signal-core.ts';
import { paintSignalLine } from './signal.ts';
import { CLOSE_ICON_PATH, CLOUD_ICON_PATH, createLineIcon } from './svg-dom.ts';
import type { ActivatableSignal } from './signal.ts';

export type SessionRowRefs = ReturnType<typeof buildSessionRow>['refs'];
type SessionRowSignalSource = (sessionId: string) => ActivatableSignal[];
const sessionRowSignalSources: SessionRowSignalSource[] = [];

const PLAN_PROMPT_KIND = 'plan';

const MERGE_SIGNALS: Readonly<Record<string, Omit<Signal, 'key'>>> = {
  parked: { text: 'PARKED', hoverText: 'Merge parked', look: { icon: 'failed', tone: 'danger' }, tier: SIGNAL_TIER.broken },
  merging: { text: 'MERGING', hoverText: 'Merging', look: { icon: 'queued', tone: 'wait' }, tier: SIGNAL_TIER.waiting },
};

export function addSessionRowSignalSource(source: SessionRowSignalSource) {
  sessionRowSignalSources.push(source);
}

function mergeSignals(mergeStatus: string): ActivatableSignal[] {
  const mergeSignal = MERGE_SIGNALS[mergeStatus];
  return mergeSignal ? [{ ...mergeSignal, key: 'merge' }] : [];
}

function paintSessionRowSignals(slot: HTMLElement) {
  const row = slot.closest<HTMLElement>('.session-row');
  const sessionId = row?.dataset.id;
  if (!row || !sessionId) return;
  const signals = [...mergeSignals(row.dataset.merge ?? ''), ...sessionRowSignalSources.flatMap((source) => source(sessionId))];
  paintSignalLine(slot, signals);
}

export function repaintSessionRowSignals() {
  for (const slot of document.querySelectorAll<HTMLElement>('.session-row-signals')) paintSessionRowSignals(slot);
}

export function buildSessionRow<Tag extends 'button' | 'div'>(tagName: Tag, extraClassName = '') {
  const row = el(tagName, `session-row ${extraClassName}`.trim());
  row.innerHTML = '<span class="session-row-glyph" aria-hidden="true"></span>'
    + '<span class="session-row-main">'
    + '<span class="session-row-title"><span class="session-row-name"></span><span class="session-row-cloud" hidden></span></span>'
    + '<span class="session-row-task" hidden></span>'
    + '<span class="session-row-ownership" hidden></span>'
    + '<span class="session-row-meta">'
    + '<span class="session-row-label"></span>'
    + '<span class="session-row-signals" hidden></span>'
    + '</span></span>'
    + '<span class="session-row-elapsed" aria-hidden="true"></span>';
  const refs = {
    glyph: query(row, '.session-row-glyph'),
    label: query(row, '.session-row-label'),
    ownership: query(row, '.session-row-ownership'),
    name: query(row, '.session-row-name'),
    cloud: query(row, '.session-row-cloud'),
    task: query(row, '.session-row-task'),
    signals: query(row, '.session-row-signals'),
    elapsed: query(row, '.session-row-elapsed'),
  };
  return { row, refs };
}

export function wrapSessionRow(row: HTMLElement, onRemove: () => void) {
  const item = el('div', 'session-row-item');
  const removeButton = el('button', 'session-row-remove');
  removeButton.append(createLineIcon(CLOSE_ICON_PATH));
  removeButton.type = 'button';
  removeButton.title = 'Remove session';
  removeButton.setAttribute('aria-label', 'Remove session');
  removeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    onRemove();
  });
  item.append(row, removeButton);
  return { item, removeButton };
}

export function paintSessionRowStatus(
  row: HTMLElement,
  refs: Pick<SessionRowRefs, 'glyph' | 'label'>,
  state: string,
  awaitingBackgroundTasks = false,
  pendingPromptKind: string | null = null,
) {
  row.dataset.state = state;
  row.dataset.prompt = pendingPromptKind ?? '';
  const { icon, label, isMonitoring } = stateChip(state, awaitingBackgroundTasks);
  const statusLabel = pendingPromptKind === PLAN_PROMPT_KIND ? 'Plan ready' : label;
  row.toggleAttribute('data-monitoring', isMonitoring);
  paintStatusIcon(refs.glyph, icon);
  refs.label.textContent = statusLabel;
  return statusLabel;
}

function paintSessionRowCloud(cloud: HTMLElement, remoteWorkspace: string | undefined): string | null {
  cloud.hidden = !remoteWorkspace;
  if (!remoteWorkspace) return null;
  cloud.title = remoteWorkspaceHoverText(remoteWorkspace);
  if (!cloud.firstChild) cloud.append(createLineIcon(CLOUD_ICON_PATH));
  return cloud.title;
}

function describeSessionOwnership(ui: SessionUi): string | null {
  const ownerUi = ui.ownerId ? sessionUIs.get(ui.ownerId) : undefined;
  const ownerName = ownerUi ? sessionName(ownerUi) : null;
  const sessionId = ui.card.dataset.id;
  const ownedCount = [...sessionUIs.values()].filter((other) => other.ownerId === sessionId).length;
  return describeOwnership({ ownerName, ownedCount });
}

function paintSessionRowOwnership(row: HTMLElement, refs: SessionRowRefs, ui: SessionUi) {
  const ownershipText = describeSessionOwnership(ui);
  refs.ownership.textContent = ownershipText ?? '';
  refs.ownership.hidden = ownershipText === null;
  row.closest<HTMLElement>('.session-row-item')?.toggleAttribute('data-owned', ui.ownerId !== null && sessionUIs.has(ui.ownerId));
  paintCardOwnership(ui.card, ownershipText);
  return ownershipText;
}

export function paintSessionRow(
  row: HTMLElement,
  refs: SessionRowRefs,
  { ui, state, name, mergeStatus }: { ui: SessionUi; state: string; name: string; mergeStatus: string },
) {
  const statusLabel = paintSessionRowStatus(row, refs, state, ui.awaitingBackgroundTasks, ui.pendingPromptKind);
  refs.name.textContent = name;
  const cloudText = paintSessionRowCloud(refs.cloud, ui.card.dataset.remoteWorkspace);
  refs.task.textContent = ui.taskTitle;
  refs.task.hidden = !ui.taskTitle || ui.taskTitle === name;
  row.dataset.merge = mergeStatus;
  paintSessionRowSignals(refs.signals);
  row.dataset.activity = ui._activity || '';
  refs.elapsed.textContent = sessionElapsedText(ui);
  const ownershipText = paintSessionRowOwnership(row, refs, ui);
  const accessibleLabel = [name, cloudText, ui.taskTitle, statusLabel, ownershipText].filter(Boolean).join(', ');
  row.setAttribute('aria-label', accessibleLabel);
  row.title = accessibleLabel;
  return statusLabel;
}
