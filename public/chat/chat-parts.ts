import { el } from '../dom-helpers.ts';
import type { ChatPart, ChatPartKind, TurnPart } from './chat-part.ts';
import { renderCard } from './chat-cards.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { digestTurn } from './turn-digest-core.ts';
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

function currentCallOf(segments: readonly TurnSegment[]): string {
  const lastRun = segments.findLast((segment): segment is ToolsSegment => segment.kind === 'tools');
  return lastRun?.labels.at(-1) ?? '';
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
    textElement.toggleAttribute('data-arriving', isArriving);
    view.body.append(textElement);
    view.textElements.push(textElement);
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

function showEndedRow(view: TurnView, part: TurnPart): void {
  const digest = digestTurn(part.segments, part.toolCount);
  view.hasWork = digest.isFoldable;
  view.element.toggleAttribute('data-foldable', digest.isFoldable);
  view.element.toggleAttribute('data-asks', digest.asked !== null);
  view.brief.replaceChildren(...(digest.asked === null ? [] : [renderAsked(digest.asked)]));
  view.meta.replaceChildren(view.chevron, ...metaFieldsOf(part));
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

function updateTurnView(view: TurnView, part: TurnPart, areNewSegmentsArriving: boolean): void {
  dropLeadingSegments(view, part.droppedSegmentCount);
  syncSegments(view, part.segments, areNewSegmentsArriving);
  const finalTextIndex = part.segments.findLastIndex((segment) => segment.kind === 'text');
  view.textElements.forEach((textElement, index) => {
    textElement?.toggleAttribute('data-before-final', index < finalTextIndex);
    textElement?.toggleAttribute('data-final', index === finalTextIndex);
  });
  view.isOver = part.isOver;
  view.part = part;
  view.element.toggleAttribute('data-over', part.isOver);
  view.element.toggleAttribute('data-has-tools', part.toolCount > 0);
  if (part.isOver) showEndedRow(view, part);
  if (!part.isOver) showRunningRow(view, part);
  showWork(view);
}

function renderSkill(part: Extract<ChatPart, { kind: 'skill' }>): HTMLElement {
  const skillLine = el('div', 'chat-skill');
  skillLine.append('Loaded skill ', el('code', null, part.skillName));
  return skillLine;
}

const RENDERER_BY_PART_KIND = {
  prompt: renderPrompt,
  skill: renderSkill,
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
}

function settleArrivalsThatCannotAnimate(logElement: HTMLElement): void {
  for (const arrivingElement of logElement.querySelectorAll('[data-arriving]')) {
    if (arrivingElement.getAnimations().length === 0) arrivingElement.removeAttribute('data-arriving');
  }
}

export function createChatLog(uploadUrlOf: UploadUrlOf, keepTurnInPlace: (turnElement: HTMLElement, change: () => void) => void): ChatLog {
  const element = el('div', 'chat-log');
  element.setAttribute('role', 'log');
  const elementByPartId = new Map<string, HTMLElement>();
  const turnViewByPartId = new Map<string, TurnView>();

  const upsertTurn = (part: TurnPart, isArriving: boolean, container: ParentNode) => {
    const existingView = turnViewByPartId.get(part.id);
    const view = existingView ?? createTurnView();
    updateTurnView(view, part, isArriving && existingView !== undefined);
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
    }
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
  const settleArrival = (event: AnimationEvent) => {
    if (event.target instanceof Element) event.target.removeAttribute('data-arriving');
  };
  element.addEventListener('animationend', settleArrival);
  element.addEventListener('animationcancel', settleArrival);
  element.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
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
  return { element, upsert, remove, replaceParts, keepLast, toggleTurn };
}
