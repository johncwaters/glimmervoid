import { writeAttributeIfChanged, writeDataIfChanged, writeHiddenIfChanged, writeTextIfChanged } from './status-paint.ts';
import { el, query, stateChip } from './dom-helpers.ts';
import { button } from './ui/button.ts';
import { createPressable } from './ui/pressable.ts';
import { describeOwnership } from './focus-view/attention-core.ts';
import { paintCardOwnership, remoteWorkspaceText } from './session-card/card-dom.ts';
import { attentionTally, sessionName, sessionUIs } from './session-card/card-registry.ts';
import { CLOSING_ROW_STATE, SESSION_CLOSE_UNDO_WINDOW_MS, pendingCloseStartedAt } from './session-actions.ts';
import { paintStatusIcon } from './status-icon.ts';
import type { SessionUi } from './session-card/card-registry.ts';
import { SHELL_AGENT_ID } from './session-card/agent-core.ts';
import { sessionElapsedText } from './session-card/session-tick.ts';
import { SIGNAL_TIER } from './signal-core.ts';
import type { Signal } from './signal-core.ts';
import { createSignal, paintSignalLine } from './signal.ts';
import { CLOSE_ICON_PATH, CLOUD_ICON_PATH, createLineIcon } from './svg-dom.ts';
import { createPrStatusIcon } from './github/pr-status-icon.ts';
import type { ActivatableSignal } from './signal.ts';
import { paintAgentMark } from './session-card/agent-mark.ts';
import { unseenManagerAnswersFor } from './session-card/card-problems.ts';

export type SessionRowRefs = ReturnType<typeof buildSessionRow>['refs'];
type SessionRowSignalSource = (sessionId: string) => ActivatableSignal[];
type SessionRowSignalSlot = 'status' | 'links';
const sessionRowSignalSources: { source: SessionRowSignalSource; slot: SessionRowSignalSlot }[] = [];
const FOCUSED_LINK_LIMIT = 5;

const PLAN_PROMPT_KIND = 'plan';

const MERGE_SIGNALS: Readonly<Record<string, Omit<Signal, 'key'>>> = {
  parked: { text: 'PARKED', look: { icon: 'failed', tone: 'danger' }, tier: SIGNAL_TIER.broken },
  merging: { text: 'MERGING', look: { icon: 'queued', tone: 'wait' }, tier: SIGNAL_TIER.waiting },
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
  const splitBoardSignalKey = row.dataset.splitBoardId ? `board:${row.dataset.splitBoardId}` : null;
  const links = signalsFromSlot(sessionId, 'links').filter((signal) => signal.key !== splitBoardSignalKey);
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

export function buildSessionRow(extraClassName = '') {
  const row = createPressable(`session-row ${extraClassName}`.trim());
  row.innerHTML = '<span class="session-row-glyph" aria-hidden="true"></span>'
    + '<span class="session-row-main">'
    + '<span class="session-row-title"><span class="agent-mark session-row-agent" aria-hidden="true" hidden></span><span class="session-row-name"></span><span class="session-row-cloud" hidden></span></span>'
    + '<span class="session-row-task" hidden></span>'
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
    name: query(row, '.session-row-name'),
    agent: query(row, '.session-row-agent'),
    cloud: query(row, '.session-row-cloud'),
    task: query(row, '.session-row-task'),
    signals: query(row, '.session-row-signals'),
    elapsed: query(row, '.session-row-elapsed'),
    attentionTab: query(row, '.session-row-attention-tab'),
  };
  return { row, refs };
}

export function wrapSessionRow(row: HTMLElement, removeLabel: string, onRemove: () => void, onUndoRemove: () => void) {
  const item = el('div', 'session-row-item');
  const removeButton = button({ variant: 'icon', size: 'small', label: removeLabel, icon: createLineIcon(CLOSE_ICON_PATH), action: 'remove-session', onClick: (event) => {
    event.stopPropagation();
    onRemove();
  } });
  const undoButton = button({ variant: 'primary', size: 'small', label: 'Undo', action: 'undo-remove', onClick: (event) => {
    event.stopPropagation();
    onUndoRemove();
  } });
  const closeCountdown = el('span', 'session-row-close-countdown');
  closeCountdown.setAttribute('aria-hidden', 'true');
  item.append(row, removeButton, undoButton, closeCountdown);
  return { item, removeButton };
}

const closeDrainByCountdown = new WeakMap<HTMLElement, Animation>();

function paintCloseCountdown(row: HTMLElement, closeStartedAt: number | null) {
  const item = row.closest<HTMLElement>('.session-row-item');
  if (!item) return;
  item.toggleAttribute('data-closing', closeStartedAt !== null);
  const countdown = item.querySelector<HTMLElement>(':scope > .session-row-close-countdown');
  if (!countdown) return;
  const drain = closeDrainByCountdown.get(countdown);
  if (drain && drain.startTime === closeStartedAt) return;
  drain?.cancel();
  closeDrainByCountdown.delete(countdown);
  if (closeStartedAt === null) return;
  const pinnedDrain = countdown.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: SESSION_CLOSE_UNDO_WINDOW_MS, fill: 'forwards' });
  pinnedDrain.startTime = closeStartedAt;
  closeDrainByCountdown.set(countdown, pinnedDrain);
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

const BOARD_LABEL = 'BOARD';

const sessionRowNamesByRow = new WeakMap<HTMLElement, { name: string; distinctTaskTitle: string | null }>();

function paintSessionRowNames(row: HTMLElement) {
  const rowNames = sessionRowNamesByRow.get(row);
  if (!rowNames) return;
  const { name, distinctTaskTitle } = rowNames;
  const namesTerminalByTask = row.hasAttribute('data-split') && distinctTaskTitle !== null;
  writeTextIfChanged(query(row, '.session-row-name'), namesTerminalByTask ? distinctTaskTitle : name);
  const taskLine = query(row, '.session-row-task');
  writeTextIfChanged(taskLine, namesTerminalByTask ? name : distinctTaskTitle ?? '');
  writeHiddenIfChanged(taskLine, distinctTaskTitle === null);
}

export function paintSessionRowSplit(row: HTMLElement, splitBoard: { id: string; title: string } | null, activePane: 'terminal' | 'board' | null) {
  const splitBoardTitle = splitBoard?.title ?? null;
  row.toggleAttribute('data-split', splitBoard !== null);
  writeDataIfChanged(row, 'activePane', activePane ?? '');
  if ((row.dataset.splitBoardId ?? '') !== (splitBoard?.id ?? '')) {
    writeDataIfChanged(row, 'splitBoardId', splitBoard?.id ?? '');
    paintSessionRowSignals(row);
  }
  paintSessionRowNames(row);
  const existingMember = row.querySelector<HTMLElement>(':scope > .session-row-main > .session-row-split-board');
  if (splitBoardTitle === null) {
    existingMember?.remove();
    return;
  }
  const member = existingMember ?? buildSplitBoardMember(row);
  writeTextIfChanged(query(member, '.session-row-split-board-title'), splitBoardTitle);
}

function buildSplitBoardMember(row: HTMLElement) {
  const titleLine = query(row, '.session-row-title');
  titleLine.dataset.member = 'terminal';
  const member = el('span', 'session-row-split-board');
  member.dataset.member = 'board';
  member.append(createPrStatusIcon('board'), el('span', 'session-row-split-board-title'));
  titleLine.after(member);
  return member;
}

export function paintBoardRow(row: HTMLElement, refs: SessionRowRefs, title: string, connectedSessionName: string | null, deleteStartedAt: number | null) {
  writeDataIfChanged(row, 'state', '');
  writeDataIfChanged(row, 'prompt', '');
  row.toggleAttribute('data-board', true);
  if (!refs.glyph.firstChild) refs.glyph.append(createPrStatusIcon('board'));
  writeTextIfChanged(refs.name, title);
  writeTextIfChanged(refs.label, BOARD_LABEL);
  writeTextIfChanged(refs.task, connectedSessionName ?? '');
  writeHiddenIfChanged(refs.task, connectedSessionName === null);
  const accessibleLabel = [title, BOARD_LABEL, connectedSessionName].filter((part) => part !== null).join(', ');
  writeAttributeIfChanged(row, 'aria-label', accessibleLabel);
  paintCloseCountdown(row, deleteStartedAt);
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
  if (!cloud.firstChild) cloud.append(createLineIcon(CLOUD_ICON_PATH));
  return remoteWorkspaceText(remoteWorkspace);
}

function describeSessionOwnership(ui: SessionUi): string | null {
  const ownerUi = ui.ownerId ? sessionUIs.get(ui.ownerId) : undefined;
  const ownerName = ownerUi ? sessionName(ownerUi) : null;
  const ownedCount = attentionTally.ownedCountByOwnerId.get(ui.card.dataset.id ?? '') ?? 0;
  return describeOwnership({ ownerName, ownedCount });
}

function paintSessionRowOwnership(row: HTMLElement, ui: SessionUi) {
  const ownershipText = describeSessionOwnership(ui);
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
  paintCloseCountdown(row, state === CLOSING_ROW_STATE && row.dataset.id !== undefined ? pendingCloseStartedAt(row.dataset.id) : null);
  sessionRowNamesByRow.set(row, { name, distinctTaskTitle: ui.taskTitle && ui.taskTitle !== name ? ui.taskTitle : null });
  paintSessionRowNames(row);
  paintAgentMark(refs.agent, ui.agent ?? null);
  const cloudText = paintSessionRowCloud(refs.cloud, ui.card.dataset.remoteWorkspace);
  writeDataIfChanged(row, 'merge', mergeStatus);
  paintSessionRowSignals(row);
  writeDataIfChanged(row, 'activity', ui._activity || '');
  writeTextIfChanged(refs.elapsed, sessionElapsedText(ui));
  const ownershipText = paintSessionRowOwnership(row, ui);
  paintSessionRowAttentionTab(row, refs.attentionTab, attentionPosition);
  const hasUnseenAnswer = row.dataset.id !== undefined && unseenManagerAnswersFor(row.dataset.id).length > 0;
  row.toggleAttribute('data-manager-answered', hasUnseenAnswer);
  const accessibleLabel = [name, cloudText, ui.taskTitle, statusLabel, ownershipText, attentionPositionText(attentionPosition), hasUnseenAnswer ? 'answered for you' : ''].filter(Boolean).join(', ');
  writeAttributeIfChanged(row, 'aria-label', accessibleLabel);
  return statusLabel;
}
