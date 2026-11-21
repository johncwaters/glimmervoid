import { el } from '../dom-helpers.ts';
import type { BackgroundTaskPart, ChatPart, ChatPartKind, SubagentPart, TurnPart } from './chat-part.ts';
import { backgroundTaskKindText, runTimeText, subagentDurationText } from './chat-parts-core.ts';
import { clock } from '#shared/clock.ts';
import { renderCard } from './chat-cards.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { currentCallOf, digestTurn, isInterimReply } from './turn-digest-core.ts';
import type { TurnSegment } from './turn-digest-core.ts';

type FlatPartKind = Exclude<ChatPartKind, 'turn'>;
type FlatPart = Exclude<ChatPart, TurnPart>;
type ChatPartByKind = { [Part in FlatPart as Part['kind']]: Part };
type UploadUrlOf = (fileName: string) => string;
type ChatPartRenderer<Kind extends FlatPartKind> = (part: ChatPartByKind[Kind], uploadUrlOf: UploadUrlOf) => HTMLElement;
type ChatPartRendererTable = { [Kind in FlatPartKind]: ChatPartRenderer<Kind> };

interface TurnView {
  element: HTMLElement;
  brief: HTMLElement;
  body: HTMLElement;
  meta: HTMLElement;
  work: HTMLElement;
  chevron: HTMLButtonElement;
  toolCount: HTMLElement;
  toolNumber: HTMLElement;
  toolWord: HTMLElement;
  currentCall: HTMLElement;
  segmentKinds: TurnSegment['kind'][];
  textElements: (HTMLElement | null)[];
  droppedSegmentCount: number;
  part: TurnPart | null;
  isOver: boolean;
  hasWork: boolean;
  isOpen: boolean;
}

type ToolsSegment = Extract<TurnSegment, { kind: 'tools' }>;
export type TurnEnd = { pill: HTMLButtonElement; list: HTMLElement };

const CHEVRON_ICON_PATH = 'M6 4l4 4-4 4';

export function renderAttachmentThumbnail(fileName: string, uploadUrlOf: UploadUrlOf): HTMLElement {
  const thumbnail = el('span', 'chat-prompt-thumbnail');
  const image = el('img', 'chat-prompt-thumbnail-image');
  image.alt = '';
  image.loading = 'lazy';
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = uploadUrlOf(fileName);
  thumbnail.append(el('span', 'chat-prompt-thumbnail-name', fileName), image);
  return thumbnail;
}

export function renderPromptBubble(text: string, attachments: readonly string[], uploadUrlOf: UploadUrlOf): HTMLElement {
  if (attachments.length === 0) return el('div', 'chat-prompt', text);
  const prompt = el('div', 'chat-prompt-with-attachments');
  const thumbnails = el('div', 'chat-prompt-thumbnails');
  thumbnails.append(...attachments.map((fileName) => renderAttachmentThumbnail(fileName, uploadUrlOf)));
  prompt.append(thumbnails);
  if (text.length > 0) prompt.append(el('div', 'chat-prompt', text));
  return prompt;
}

function renderPrompt(part: Extract<ChatPart, { kind: 'prompt' }>, uploadUrlOf: UploadUrlOf): HTMLElement {
  return renderPromptBubble(part.text, part.attachments, uploadUrlOf);
}

function countText(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const BLOCK_REVEAL_GAP_MS = 50;
const BLOCK_REVEAL_CAP_MS = 600;
const LAST_REVEAL_BLOCK_ATTRIBUTE = 'data-reveal-last';

function revealBlocksOf(textElement: Element): Element[] {
  return [...(textElement.firstElementChild?.children ?? [])];
}

function staggerBlockReveal(textElement: HTMLElement): void {
  const blocks = revealBlocksOf(textElement);
  for (const [index, block] of blocks.entries()) {
    if (block instanceof HTMLElement) block.style.setProperty('--line-delay', `${Math.min(index * BLOCK_REVEAL_GAP_MS, BLOCK_REVEAL_CAP_MS)}ms`);
  }
  blocks.at(-1)?.setAttribute(LAST_REVEAL_BLOCK_ATTRIBUTE, '');
}

function isEarlierRevealBlock(element: Element): boolean {
  const isRevealBlock = element.parentElement?.parentElement?.matches('.chat-turn-text[data-arriving]') === true;
  return isRevealBlock && !element.hasAttribute(LAST_REVEAL_BLOCK_ATTRIBUTE);
}

function settleArrival(arrivingElement: Element): void {
  const isRevealingText = arrivingElement.classList.contains('chat-turn-text');
  if (arrivingElement.getAnimations(isRevealingText ? { subtree: true } : {}).length > 0) return;
  arrivingElement.removeAttribute('data-arriving');
  if (!isRevealingText) return;
  for (const block of revealBlocksOf(arrivingElement)) {
    block.removeAttribute(LAST_REVEAL_BLOCK_ATTRIBUTE);
    if (block instanceof HTMLElement) block.style.removeProperty('--line-delay');
  }
}

function renderTextSegment(text: string): HTMLElement {
  const textElement = el('div', 'chat-turn-text');
  const textBody = renderPlanBlocks(parsePlanMarkdown(text));
  for (const anchoredHeading of textBody.querySelectorAll('[id]')) anchoredHeading.removeAttribute('id');
  textElement.append(textBody);
  return textElement;
}

function callRowsOf(segment: ToolsSegment): HTMLElement[] {
  const callRows = segment.labels.map((label) => el('div', 'chat-turn-call', label));
  const unkeptCallCount = segment.callCount - segment.labels.length;
  if (unkeptCallCount <= 0) return callRows;
  return [el('div', 'chat-turn-call', `+ ${unkeptCallCount} earlier`), ...callRows];
}

function workRowsOf(part: TurnPart): HTMLElement[] {
  const replyIndex = part.isOver ? part.segments.findLastIndex((segment) => segment.kind === 'text') : -1;
  const rows = part.segments.flatMap((segment, index) => {
    if (index === replyIndex) return [];
    if (segment.kind === 'tools') return callRowsOf(segment);
    return part.isOver ? [renderTextSegment(segment.text)] : [];
  });
  if (part.droppedSegmentCount === 0) return rows;
  return [el('div', 'chat-turn-call', `+ ${part.droppedSegmentCount} earlier steps`), ...rows];
}

function renderAsked(asked: string): HTMLElement {
  const askedElement = el('p', 'chat-turn-asked');
  askedElement.append(el('span', 'chat-turn-asked-mark', '?'), el('span', 'chat-turn-asked-text', asked));
  return askedElement;
}

function metaFieldsOf(part: TurnPart): HTMLElement[] {
  const fields: HTMLElement[] = [];
  if (part.toolCount > 0) fields.push(el('span', 'chat-turn-fact', countText(part.toolCount, 'tool', 'tools')));
  const { fileEdits } = part;
  if (fileEdits.fileCount > 0) {
    const files = el('span', 'chat-turn-fact', countText(fileEdits.fileCount, 'file', 'files'));
    if (fileEdits.hasLineCounts) files.append(' ', el('span', 'chat-turn-added', `+${fileEdits.added}`), ' ', el('span', 'chat-turn-removed', `-${fileEdits.removed}`));
    fields.push(files);
  }
  if (part.durationText !== null) fields.push(el('span', 'chat-turn-time', part.durationText));
  return fields;
}

function createTurnView(): TurnView {
  const element = el('div', 'chat-turn');
  element.tabIndex = -1;
  const brief = el('div', 'chat-turn-brief');
  const body = el('div', 'chat-turn-body');
  const meta = el('div', 'chat-turn-meta');
  const work = el('div', 'chat-turn-work');
  const chevron = button({ variant: 'icon', size: 'small', label: 'Turn details', icon: createLineIcon(CHEVRON_ICON_PATH, '1.6') });
  chevron.classList.add('chat-turn-chevron');
  const toolNumber = el('span', 'chat-turn-tool-number');
  const toolWord = el('span', 'chat-turn-tool-word');
  const toolCount = el('span', 'chat-turn-tool-count');
  toolCount.append(toolNumber, toolWord);
  const currentCall = el('span', 'chat-turn-tool');
  element.append(body, brief, meta, work);
  return { element, brief, body, meta, work, chevron, toolCount, toolNumber, toolWord, currentCall, segmentKinds: [], textElements: [], droppedSegmentCount: 0, part: null, isOver: false, hasWork: false, isOpen: false };
}

function dropLeadingSegments(view: TurnView, droppedSegmentCount: number): void {
  const newlyDroppedCount = droppedSegmentCount - view.droppedSegmentCount;
  if (newlyDroppedCount <= 0) return;
  for (const droppedElement of view.textElements.splice(0, newlyDroppedCount)) droppedElement?.remove();
  view.segmentKinds.splice(0, newlyDroppedCount);
  view.droppedSegmentCount = droppedSegmentCount;
}

function syncSegments(view: TurnView, segments: readonly TurnSegment[], isArriving: boolean): void {
  for (const segment of segments.slice(view.segmentKinds.length)) {
    view.segmentKinds.push(segment.kind);
    if (segment.kind === 'tools') {
      view.textElements.push(null);
      continue;
    }
    const textElement = renderTextSegment(segment.text);
    view.body.append(textElement);
    view.textElements.push(textElement);
    if (!isArriving) continue;
    textElement.setAttribute('data-arriving', '');
    staggerBlockReveal(textElement);
  }
}

function tickToolNumber(view: TurnView, toolCount: number): void {
  const countText = String(toolCount);
  if (view.toolNumber.textContent === countText) return;
  const tickedNumber = el('span', 'chat-turn-tool-number', countText);
  if (view.toolNumber.textContent !== '') tickedNumber.setAttribute('data-ticked', '');
  view.toolNumber.replaceWith(tickedNumber);
  view.toolNumber = tickedNumber;
}

function showRunningRow(view: TurnView, part: TurnPart): void {
  view.hasWork = part.toolCount > 0;
  if (view.toolCount.parentElement !== view.meta) view.meta.replaceChildren(view.chevron, view.toolCount, view.currentCall);
  tickToolNumber(view, part.toolCount);
  view.toolWord.textContent = part.toolCount === 1 ? 'tool call' : 'tool calls';
  view.currentCall.textContent = currentCallOf(part.segments);
}

function showEndedRow(view: TurnView, part: TurnPart, turnEnd: TurnEnd | null): void {
  const digest = digestTurn(part.segments, part.toolCount);
  view.hasWork = digest.isFoldable;
  view.element.toggleAttribute('data-foldable', digest.isFoldable);
  view.element.toggleAttribute('data-asks', digest.asked !== null);
  view.brief.replaceChildren(...(digest.asked === null ? [] : [renderAsked(digest.asked)]));
  const metaChildren = [view.chevron, ...metaFieldsOf(part)];
  if (turnEnd === null) {
    view.meta.replaceChildren(...metaChildren);
    return;
  }
  for (const child of [...view.meta.children]) if (child !== turnEnd.pill) child.remove();
  if (turnEnd.pill.parentElement !== view.meta) view.meta.append(turnEnd.pill);
  turnEnd.pill.before(...metaChildren);
  if (turnEnd.list.previousElementSibling !== view.work) view.work.after(turnEnd.list);
}

function showWork(view: TurnView): void {
  const isOpen = view.isOpen && view.hasWork && view.part !== null;
  view.element.toggleAttribute('data-open', isOpen);
  view.chevron.setAttribute('aria-expanded', String(isOpen));
  if (!isOpen || view.part === null) {
    view.work.replaceChildren();
    return;
  }
  view.work.replaceChildren(...workRowsOf(view.part));
}

function updateTurnView(view: TurnView, part: TurnPart, areNewSegmentsArriving: boolean, turnEnd: TurnEnd | null): void {
  dropLeadingSegments(view, part.droppedSegmentCount);
  syncSegments(view, part.segments, areNewSegmentsArriving);
  const finalTextIndex = part.segments.findLastIndex((segment) => segment.kind === 'text');
  view.textElements.forEach((textElement, index) => {
    const segment = part.segments[index];
    textElement?.toggleAttribute('data-interim', segment?.kind === 'text' && isInterimReply(segment.text));
    textElement?.toggleAttribute('data-before-final', index < finalTextIndex);
    textElement?.toggleAttribute('data-final', index === finalTextIndex);
  });
  view.isOver = part.isOver;
  view.part = part;
  view.element.toggleAttribute('data-over', part.isOver);
  view.element.toggleAttribute('data-has-tools', part.toolCount > 0);
  if (part.isOver) showEndedRow(view, part, turnEnd);
  if (!part.isOver) showRunningRow(view, part);
  showWork(view);
}

function renderSkill(part: Extract<ChatPart, { kind: 'skill' }>): HTMLElement {
  const skillLine = el('div', 'chat-skill');
  skillLine.append('Loaded skill ', el('code', null, part.skillName));
  return skillLine;
}

function subagentStepRowsOf(part: SubagentPart): HTMLElement[] {
  const stepRows = part.steps.map((label) => el('div', 'chat-turn-call', label));
  const unkeptStepCount = part.stepCount - part.steps.length;
  if (unkeptStepCount <= 0) return stepRows;
  return [el('div', 'chat-turn-call', `+ ${unkeptStepCount} earlier`), ...stepRows];
}

function renderSubagent(part: SubagentPart): HTMLElement {
  const subagent = el('details', 'chat-subagent');
  subagent.toggleAttribute('data-running', part.endedAt === null);
  const row = el('summary', 'chat-subagent-row');
  row.append(
    el('span', 'chat-subagent-dot'),
    el('span', 'chat-subagent-type', part.subagentType),
    el('span', 'chat-subagent-task', part.task ?? ''),
    el('span', 'chat-subagent-time', subagentDurationText(part) ?? 'Running'),
    createLineIcon(CHEVRON_ICON_PATH, '1.6'),
  );
  const work = el('div', 'chat-subagent-work');
  work.append(...subagentStepRowsOf(part));
  if (part.report !== null) work.append(renderTextSegment(part.report));
  if (part.endedAt === null) work.append(el('div', 'chat-turn-call', 'Running'));
  if (part.endedAt !== null && part.report === null && part.stepCount === 0) work.append(el('div', 'chat-turn-call', 'No report'));
  subagent.append(row, work);
  return subagent;
}

function renderBackgroundTask(part: BackgroundTaskPart): HTMLElement {
  const backgroundTask = el('details', 'chat-subagent');
  backgroundTask.toggleAttribute('data-running', part.endedAt === null);
  const row = el('summary', 'chat-subagent-row');
  row.append(
    el('span', 'chat-subagent-dot'),
    el('span', 'chat-subagent-type', backgroundTaskKindText(part.taskType)),
    el('span', 'chat-subagent-task', part.label),
    el('span', 'chat-subagent-time', part.endedAt === null ? '' : runTimeText(part.startedAt, part.endedAt)),
    createLineIcon(CHEVRON_ICON_PATH, '1.6'),
  );
  const work = el('div', 'chat-subagent-work');
  work.append(el('div', 'chat-turn-call', part.command ?? part.label));
  backgroundTask.append(row, work);
  return backgroundTask;
}

function startedAtOfRunning(part: FlatPart): number | null {
  if (part.kind !== 'subagent' && part.kind !== 'background-task') return null;
  return part.endedAt === null ? part.startedAt : null;
}

const RENDERER_BY_PART_KIND = {
  prompt: renderPrompt,
  skill: renderSkill,
  subagent: renderSubagent,
  'background-task': renderBackgroundTask,
  card: (part) => renderCard(part.card),
} satisfies ChatPartRendererTable;

const rendererByPartKind: ChatPartRendererTable = RENDERER_BY_PART_KIND;

function renderPartOfKind<Kind extends FlatPartKind>(kind: Kind, part: ChatPartByKind[Kind], uploadUrlOf: UploadUrlOf): HTMLElement {
  return rendererByPartKind[kind](part, uploadUrlOf);
}

function renderPart(part: FlatPart, uploadUrlOf: UploadUrlOf): HTMLElement {
  const element = renderPartOfKind(part.kind, part, uploadUrlOf);
  element.dataset.partId = part.id;
  return element;
}

interface ChatLog {
  element: HTMLElement;
  upsert(parts: readonly ChatPart[], arrivingPartIds: ReadonlySet<string>): void;
  remove(partIds: readonly string[]): void;
  replaceParts(replacedPartIds: readonly string[], parts: readonly ChatPart[]): void;
  keepLast(partIds: readonly string[]): void;
  toggleTurn(turnElement: HTMLElement): void;
  showTurnEnd(turnEnd: TurnEnd | null): boolean;
  tickRunTimes(): boolean;
}

function settleArrivalsThatCannotAnimate(logElement: HTMLElement): void {
  for (const arrivingElement of logElement.querySelectorAll('[data-arriving]')) settleArrival(arrivingElement);
}

export function createChatLog(uploadUrlOf: UploadUrlOf, keepTurnInPlace: (turnElement: HTMLElement, change: () => void) => void): ChatLog {
  const element = el('div', 'chat-log');
  element.setAttribute('role', 'log');
  const elementByPartId = new Map<string, HTMLElement>();
  const turnViewByPartId = new Map<string, TurnView>();
  const runningTimeByPartId = new Map<string, { timeElement: Element; startedAt: number }>();
  const showRunTime = ({ timeElement, startedAt }: { timeElement: Element; startedAt: number }) => {
    timeElement.textContent = runTimeText(startedAt, Math.max(startedAt, clock.nowMs()));
  };
  const noteRunningTime = (part: FlatPart, rendered: HTMLElement) => {
    const startedAt = startedAtOfRunning(part);
    const timeElement = rendered.querySelector('.chat-subagent-time');
    if (startedAt === null || timeElement === null) {
      runningTimeByPartId.delete(part.id);
      return;
    }
    const runningTime = { timeElement, startedAt };
    runningTimeByPartId.set(part.id, runningTime);
    showRunTime(runningTime);
  };
  const tickRunTimes = () => {
    for (const runningTime of runningTimeByPartId.values()) showRunTime(runningTime);
    return runningTimeByPartId.size > 0;
  };
  let lastTurnView: TurnView | null = null;
  let shownTurnEnd: TurnEnd | null = null;
  const turnEndOf = (view: TurnView) => (view === lastTurnView ? shownTurnEnd : null);
  const findLastTurnView = () => {
    const turnElements = element.querySelectorAll<HTMLElement>(':scope > .chat-turn');
    const lastPartId = turnElements[turnElements.length - 1]?.dataset.partId;
    lastTurnView = lastPartId === undefined ? null : turnViewByPartId.get(lastPartId) ?? null;
  };
  const removeTurnEnd = () => {
    shownTurnEnd?.pill.remove();
    shownTurnEnd?.list.remove();
  };
  const placeTurnEnd = () => {
    if (shownTurnEnd === null || lastTurnView?.part?.isOver !== true) return false;
    showEndedRow(lastTurnView, lastTurnView.part, shownTurnEnd);
    return true;
  };

  const upsertTurn = (part: TurnPart, isArriving: boolean, container: ParentNode) => {
    const existingView = turnViewByPartId.get(part.id);
    const view = existingView ?? createTurnView();
    if (!existingView) lastTurnView = view;
    updateTurnView(view, part, isArriving, turnEndOf(view));
    if (existingView) return;
    view.element.toggleAttribute('data-arriving', isArriving);
    view.element.dataset.partId = part.id;
    turnViewByPartId.set(part.id, view);
    elementByPartId.set(part.id, view.element);
    container.appendChild(view.element);
  };
  const upsertFlat = (part: FlatPart, isArriving: boolean, container: ParentNode) => {
    const rendered = renderPart(part, uploadUrlOf);
    const existing = elementByPartId.get(part.id);
    elementByPartId.set(part.id, rendered);
    noteRunningTime(part, rendered);
    if (existing instanceof HTMLDetailsElement && rendered instanceof HTMLDetailsElement) rendered.open = existing.open;
    if (existing) {
      existing.replaceWith(rendered);
      return;
    }
    rendered.toggleAttribute('data-arriving', isArriving);
    container.appendChild(rendered);
  };
  const upsertInto = (container: ParentNode, parts: readonly ChatPart[], arrivingPartIds: ReadonlySet<string>) => {
    if (arrivingPartIds.size > 0) requestAnimationFrame(() => settleArrivalsThatCannotAnimate(element));
    for (const part of parts) {
      const isArriving = arrivingPartIds.has(part.id);
      if (part.kind === 'turn') {
        upsertTurn(part, isArriving, container);
        continue;
      }
      upsertFlat(part, isArriving, container);
    }
  };
  const upsert = (parts: readonly ChatPart[], arrivingPartIds: ReadonlySet<string>) => upsertInto(element, parts, arrivingPartIds);
  const remove = (partIds: readonly string[]) => {
    for (const partId of partIds) {
      elementByPartId.get(partId)?.remove();
      elementByPartId.delete(partId);
      turnViewByPartId.delete(partId);
      runningTimeByPartId.delete(partId);
    }
    findLastTurnView();
    placeTurnEnd();
  };
  const replaceParts = (replacedPartIds: readonly string[], parts: readonly ChatPart[]) => {
    const replacedIndexByElement = new Map<Element, number>();
    replacedPartIds.forEach((partId, index) => {
      const replaced = elementByPartId.get(partId);
      if (replaced) replacedIndexByElement.set(replaced, index);
    });
    const keptElementsAfterReplaced: { kept: Element; replacedIndexBefore: number }[] = [];
    let replacedIndexBefore = -1;
    for (const child of element.children) {
      const replacedIndex = replacedIndexByElement.get(child);
      if (replacedIndex !== undefined) {
        replacedIndexBefore = replacedIndex;
        continue;
      }
      if (replacedIndexBefore >= 0) keptElementsAfterReplaced.push({ kept: child, replacedIndexBefore });
    }
    const openReplacedIndexes = new Set<number>();
    let focusedReplacedIndex = -1;
    for (const [replaced, index] of replacedIndexByElement) {
      if (turnViewByPartId.get(replacedPartIds[index] ?? '')?.isOpen) openReplacedIndexes.add(index);
      if (replaced.contains(document.activeElement)) focusedReplacedIndex = index;
    }
    const isTurnEndFocused = shownTurnEnd?.pill.contains(document.activeElement) === true;
    const insertionMark = document.createComment('');
    const firstReplacedElement = replacedIndexByElement.keys().next().value ?? element.firstElementChild;
    if (firstReplacedElement) firstReplacedElement.before(insertionMark);
    if (!firstReplacedElement) element.append(insertionMark);
    remove(replacedPartIds);
    const rebuiltElements = document.createDocumentFragment();
    upsertInto(rebuiltElements, parts, new Set());
    insertionMark.replaceWith(rebuiltElements);
    const rebuiltIndexShift = parts.length - replacedPartIds.length;
    const rebuiltPartIdOf = (replacedIndex: number) => parts[replacedIndex + rebuiltIndexShift]?.id ?? '';
    for (const openIndex of openReplacedIndexes) {
      const rebuiltView = turnViewByPartId.get(rebuiltPartIdOf(openIndex));
      if (!rebuiltView) continue;
      rebuiltView.isOpen = true;
      showWork(rebuiltView);
    }
    if (focusedReplacedIndex >= 0) elementByPartId.get(rebuiltPartIdOf(focusedReplacedIndex))?.focus({ preventScroll: true });
    for (const { kept, replacedIndexBefore: index } of keptElementsAfterReplaced.reverse()) {
      elementByPartId.get(rebuiltPartIdOf(index))?.after(kept);
    }
    findLastTurnView();
    if (placeTurnEnd() && isTurnEndFocused) shownTurnEnd?.pill.focus({ preventScroll: true });
  };
  const toggleTurn = (turnElement: HTMLElement) => {
    const partId = turnElement.dataset.partId;
    const view = partId === undefined ? undefined : turnViewByPartId.get(partId);
    if (!view?.hasWork) return;
    keepTurnInPlace(view.element, () => {
      view.isOpen = !view.isOpen;
      showWork(view);
    });
  };
  const settleAnimatedArrival = (event: AnimationEvent) => {
    if (!(event.target instanceof Element) || isEarlierRevealBlock(event.target)) return;
    const arrivingElement = event.target.closest('[data-arriving]');
    if (arrivingElement) settleArrival(arrivingElement);
  };
  element.addEventListener('animationend', settleAnimatedArrival);
  element.addEventListener('animationcancel', settleAnimatedArrival);
  element.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const subagentRow = event.target.closest('.chat-subagent-row');
    const subagent = subagentRow?.parentElement;
    if (subagent instanceof HTMLDetailsElement) {
      event.preventDefault();
      keepTurnInPlace(subagent, () => { subagent.open = !subagent.open; });
      return;
    }
    const meta = event.target.closest('.chat-turn-meta');
    const turnElement = meta?.closest<HTMLElement>('.chat-turn');
    if (!turnElement) return;
    toggleTurn(turnElement);
    turnElement.focus({ preventScroll: true });
  });
  const keepLast = (partIds: readonly string[]) => {
    const pinnedElements = partIds.flatMap((partId) => elementByPartId.get(partId) ?? []);
    const pinnedSet = new Set<Element>(pinnedElements);
    const children = [...element.children];
    const firstPinnedIndex = children.findIndex((child) => pinnedSet.has(child));
    if (firstPinnedIndex < 0) return;
    const partsAfterPinned = children.slice(firstPinnedIndex).filter((child) => !pinnedSet.has(child));
    children[firstPinnedIndex]?.before(...partsAfterPinned);
    const tailElements = [...element.children].slice(-pinnedElements.length);
    const firstMisplacedIndex = pinnedElements.findIndex((pinned, index) => tailElements[index] !== pinned);
    if (firstMisplacedIndex < 0) return;
    element.append(...pinnedElements.slice(firstMisplacedIndex));
  };
  const showTurnEnd = (turnEnd: TurnEnd | null) => {
    if (turnEnd === null) removeTurnEnd();
    shownTurnEnd = turnEnd;
    return placeTurnEnd();
  };
  return { element, upsert, remove, replaceParts, keepLast, toggleTurn, showTurnEnd, tickRunTimes };
}
