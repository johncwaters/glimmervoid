import { writeAttributeIfChanged, writeDataIfChanged, writeHiddenIfChanged, writeTextIfChanged } from './status-paint.ts';
import { el, query, stateChip } from './dom-helpers.ts';
import { describeOwnership } from './focus-view/attention-core.ts';
import { paintCardOwnership, remoteWorkspaceHoverText } from './session-card/card-dom.ts';
import { attentionTally, sessionName, sessionUIs } from './session-card/card-registry.ts';
import { CLOSING_ROW_STATE, SESSION_CLOSE_UNDO_WINDOW_MS } from './session-actions.ts';
import { paintStatusIcon } from './status-icon.ts';
import type { SessionUi } from './session-card/card-registry.ts';
import { SHELL_AGENT_ID } from './session-card/agent-core.ts';
import { sessionElapsedText } from './session-card/session-tick.ts';
import { SIGNAL_TIER } from './signal-core.ts';
import type { Signal } from './signal-core.ts';
import { createSignal, paintSignalLine } from './signal.ts';
import { CLOSE_ICON_PATH, CLOUD_ICON_PATH, createLineIcon } from './svg-dom.ts';
import type { ActivatableSignal } from './signal.ts';

export type SessionRowRefs = ReturnType<typeof buildSessionRow>['refs'];
type SessionRowSignalSource = (sessionId: string) => ActivatableSignal[];
type SessionRowSignalSlot = 'status' | 'links';
const sessionRowSignalSources: { source: SessionRowSignalSource; slot: SessionRowSignalSlot }[] = [];
const FOCUSED_LINK_LIMIT = 5;

const PLAN_PROMPT_KIND = 'plan';

const MERGE_SIGNALS: Readonly<Record<string, Omit<Signal, 'key'>>> = {
  parked: { text: 'PARKED', hoverText: 'Merge parked', look: { icon: 'failed', tone: 'danger' }, tier: SIGNAL_TIER.broken },
  merging: { text: 'MERGING', hoverText: 'Merging', look: { icon: 'queued', tone: 'wait' }, tier: SIGNAL_TIER.waiting },
};

export function addSessionRowSignalSource(source: SessionRowSignalSource, slot: SessionRowSignalSlot = 'status') {
  sessionRowSignalSources.push({ source, slot });
}

function mergeSignals(mergeStatus: string): ActivatableSignal[] {
  const mergeSignal = MERGE_SIGNALS[mergeStatus];
  return mergeSignal ? [{ ...mergeSignal, key: 'merge' }] : [];
}

function signalsFromSlot(sessionId: string, slot: SessionRowSignalSlot): ActivatableSignal[] {
  return sessionRowSignalSources.filter((registered) => registered.slot === slot).flatMap((registered) => registered.source(sessionId));
}

function buildLinkListItem(signal: ActivatableSignal): HTMLElement {
  const item = createSignal({ ...signal, text: signal.detailText ?? signal.text }, signal);
  item.classList.add('session-row-link-item');
  if (signal.stateText) item.append(el('span', 'session-row-link-state', signal.stateText));
  return item;
}

function paintSessionRowLinks(row: HTMLElement, linksSlot: HTMLElement, sessionId: string) {
  const links = signalsFromSlot(sessionId, 'links');
  const isExpanded = row.classList.contains('focused');
  linksSlot.toggleAttribute('data-expanded', isExpanded);
  if (!isExpanded) {
    linksSlot.removeAttribute('data-links-revealed');
    paintSignalLine(linksSlot, links, undefined, { visibleCount: links.length, variant: 'line' });
    return;
  }
  if (linksSlot.hasAttribute('data-links-revealed')) {
    paintSignalLine(linksSlot, links, buildLinkListItem, { visibleCount: links.length, variant: 'revealed' });
    return;
  }
  const revealHiddenLinks = () => {
    linksSlot.setAttribute('data-links-revealed', '');
    paintSessionRowLinks(row, linksSlot, sessionId);
  };
  paintSignalLine(linksSlot, links, buildLinkListItem, { visibleCount: FOCUSED_LINK_LIMIT, variant: 'expanded', onRevealOverflow: revealHiddenLinks });
}

function paintSessionRowSignals(row: HTMLElement) {
  const sessionId = row.dataset.id;
  const statusSlot = row.querySelector<HTMLElement>('.session-row-signals');
  const linksSlot = row.querySelector<HTMLElement>('.session-row-links');
  if (!sessionId || !statusSlot || !linksSlot) return;
  paintSignalLine(statusSlot, [...mergeSignals(row.dataset.merge ?? ''), ...signalsFromSlot(sessionId, 'status')]);
  paintSessionRowLinks(row, linksSlot, sessionId);
}

export function repaintSessionRowSignals() {
  for (const row of document.querySelectorAll<HTMLElement>('.session-row')) paintSessionRowSignals(row);
}

export function repaintSessionRowSignalsFor(sessionId: string) {
  for (const row of document.querySelectorAll<HTMLElement>(`.session-row[data-id="${CSS.escape(sessionId)}"]`)) paintSessionRowSignals(row);
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
    + '</span>'
    + '<span class="session-row-links" hidden></span>'
    + '</span>'
    + '<span class="session-row-elapsed" aria-hidden="true"></span>'
    + '<span class="session-row-attention-tab" aria-hidden="true" hidden></span>';
  const refs = {
    glyph: query(row, '.session-row-glyph'),
    label: query(row, '.session-row-label'),
    ownership: query(row, '.session-row-ownership'),
    name: query(row, '.session-row-name'),
    cloud: query(row, '.session-row-cloud'),
    task: query(row, '.session-row-task'),
    signals: query(row, '.session-row-signals'),
    elapsed: query(row, '.session-row-elapsed'),
    attentionTab: query(row, '.session-row-attention-tab'),
  };
  return { row, refs };
}

export function wrapSessionRow(row: HTMLElement, onRemove: () => void, onUndoRemove: () => void) {
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
  const undoButton = el('button', 'session-row-undo', 'Undo');
  undoButton.type = 'button';
  undoButton.addEventListener('click', (event) => {
    event.stopPropagation();
    onUndoRemove();
  });
  const closeCountdown = el('span', 'session-row-close-countdown');
  closeCountdown.setAttribute('aria-hidden', 'true');
  closeCountdown.style.animationDuration = `${SESSION_CLOSE_UNDO_WINDOW_MS}ms`;
  item.append(row, removeButton, undoButton, closeCountdown);
  return { item, removeButton };
}

export function paintSessionRowStatus(
  row: HTMLElement,
  refs: Pick<SessionRowRefs, 'glyph' | 'label'>,
  state: string,
  awaitingBackgroundTasks = false,
  pendingPromptKind: string | null = null,
) {
  writeDataIfChanged(row, 'state', state);
  writeDataIfChanged(row, 'prompt', pendingPromptKind ?? '');
  const { icon, label, isMonitoring } = stateChip(state, awaitingBackgroundTasks);
  const statusLabel = pendingPromptKind === PLAN_PROMPT_KIND ? 'Plan ready' : label;
  row.toggleAttribute('data-monitoring', isMonitoring);
  paintStatusIcon(refs.glyph, icon);
  writeTextIfChanged(refs.label, statusLabel);
  return statusLabel;
}

const SHELL_LABEL = 'SHELL';

function paintShellRowMark(row: HTMLElement, refs: Pick<SessionRowRefs, 'glyph' | 'label'>) {
  writeDataIfChanged(row, 'state', '');
  writeDataIfChanged(row, 'prompt', '');
  row.removeAttribute('data-monitoring');
  paintStatusIcon(refs.glyph, 'shell');
  writeTextIfChanged(refs.label, SHELL_LABEL);
  return SHELL_LABEL;
}

function paintSessionRowMark(row: HTMLElement, refs: SessionRowRefs, ui: SessionUi, state: string) {
  const isShell = ui.agent === SHELL_AGENT_ID;
  row.toggleAttribute('data-shell', isShell);
  if (isShell) return paintShellRowMark(row, refs);
  return paintSessionRowStatus(row, refs, state, ui.awaitingBackgroundTasks, ui.pendingPromptKind);
}

function paintSessionRowCloud(cloud: HTMLElement, remoteWorkspace: string | undefined): string | null {
  writeHiddenIfChanged(cloud, !remoteWorkspace);
  if (!remoteWorkspace) return null;
  cloud.title = remoteWorkspaceHoverText(remoteWorkspace);
  if (!cloud.firstChild) cloud.append(createLineIcon(CLOUD_ICON_PATH));
  return cloud.title;
}

function describeSessionOwnership(ui: SessionUi): string | null {
  const ownerUi = ui.ownerId ? sessionUIs.get(ui.ownerId) : undefined;
  const ownerName = ownerUi ? sessionName(ownerUi) : null;
  const ownedCount = attentionTally.ownedCountByOwnerId.get(ui.card.dataset.id ?? '') ?? 0;
  return describeOwnership({ ownerName, ownedCount });
}

function paintSessionRowOwnership(row: HTMLElement, refs: SessionRowRefs, ui: SessionUi) {
  const ownershipText = describeSessionOwnership(ui);
  writeTextIfChanged(refs.ownership, ownershipText ?? '');
  writeHiddenIfChanged(refs.ownership, ownershipText === null);
  row.closest<HTMLElement>('.session-row-item')?.toggleAttribute('data-owned', ui.ownerId !== null && sessionUIs.has(ui.ownerId));
  paintCardOwnership(ui.card, ownershipText);
  return ownershipText;
}

function attentionPositionText(attentionPosition: number | null): string | null {
  if (attentionPosition === null) return null;
  return attentionPosition === 1 ? 'next up' : `#${attentionPosition} in line`;
}

function paintSessionRowAttentionTab(row: HTMLElement, attentionTab: HTMLElement, attentionPosition: number | null) {
  writeHiddenIfChanged(attentionTab, attentionPosition === null);
  writeTextIfChanged(attentionTab, attentionPosition === null ? '' : String(attentionPosition));
  row.toggleAttribute('data-attention-head', attentionPosition === 1);
}

export function paintSessionRow(
  row: HTMLElement,
  refs: SessionRowRefs,
  { ui, state, name, mergeStatus, attentionPosition }: { ui: SessionUi; state: string; name: string; mergeStatus: string; attentionPosition: number | null },
) {
  const statusLabel = paintSessionRowMark(row, refs, ui, state);
  row.closest<HTMLElement>('.session-row-item')?.toggleAttribute('data-closing', state === CLOSING_ROW_STATE);
  writeTextIfChanged(refs.name, name);
  const cloudText = paintSessionRowCloud(refs.cloud, ui.card.dataset.remoteWorkspace);
  writeTextIfChanged(refs.task, ui.taskTitle ?? '');
  writeHiddenIfChanged(refs.task, !ui.taskTitle || ui.taskTitle === name);
  writeDataIfChanged(row, 'merge', mergeStatus);
  paintSessionRowSignals(row);
  writeDataIfChanged(row, 'activity', ui._activity || '');
  writeTextIfChanged(refs.elapsed, sessionElapsedText(ui));
  const ownershipText = paintSessionRowOwnership(row, refs, ui);
  paintSessionRowAttentionTab(row, refs.attentionTab, attentionPosition);
  const accessibleLabel = [name, cloudText, ui.taskTitle, statusLabel, ownershipText, attentionPositionText(attentionPosition)].filter(Boolean).join(', ');
  writeAttributeIfChanged(row, 'aria-label', accessibleLabel);
  writeAttributeIfChanged(row, 'title', accessibleLabel);
  return statusLabel;
}
