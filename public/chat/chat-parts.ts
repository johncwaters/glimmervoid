import { el } from '../dom-helpers.ts';
import type { ChatPart, ChatPartKind, TurnPart } from './chat-part.ts';
import { renderCard } from './chat-cards.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { digestTurn, isCollapsedByDefault } from './turn-digest-core.ts';
import type { TurnLead, TurnSegment } from './turn-digest-core.ts';

type FlatPartKind = Exclude<ChatPartKind, 'turn'>;
type FlatPart = Exclude<ChatPart, TurnPart>;
type ChatPartByKind = { [Part in FlatPart as Part['kind']]: Part };
type UploadUrlOf = (fileName: string) => string;
type ChatPartRenderer<Kind extends FlatPartKind> = (part: ChatPartByKind[Kind], uploadUrlOf: UploadUrlOf) => HTMLElement;
type ChatPartRendererTable = { [Kind in FlatPartKind]: ChatPartRenderer<Kind> };

export interface SeenTurns {
  readSeenTurnKey(): number | null;
  markSeen(turnKey: number): void;
}

interface TurnView {
  element: HTMLElement;
  brief: HTMLElement;
  body: HTMLElement;
  meta: HTMLElement;
  chevron: HTMLButtonElement;
  renderedSegments: TurnSegment[];
  segmentElements: HTMLElement[];
  droppedSegmentCount: number;
  turnKey: number | null;
  isOver: boolean;
  isFoldable: boolean;
}

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

function renderSegment(segment: TurnSegment): HTMLElement {
  if (segment.kind === 'text') return renderTextSegment(segment.text);
  const tools = el('div', 'chat-turn-tools');
  tools.append(...segment.labels.map((label) => el('span', 'chat-turn-tool', label)));
  return tools;
}

function renderLead(lead: TurnLead): HTMLElement {
  if (lead.kind === 'text') return el('p', 'chat-turn-lead', lead.text);
  const leadElement = el('p', 'chat-turn-lead chat-turn-lead-code');
  const fileNameText = lead.fileName.length > 0 ? ` ${lead.fileName},` : ',';
  leadElement.append(el('span', 'chat-turn-code-mark', 'code'), `${fileNameText} ${countText(lead.lineCount, 'line', 'lines')}`);
  return leadElement;
}

function renderAsked(asked: string): HTMLElement {
  const askedElement = el('p', 'chat-turn-asked');
  askedElement.append(el('span', 'chat-turn-asked-mark', '?'), el('span', 'chat-turn-asked-text', asked));
  return askedElement;
}

function metaFieldsOf(part: TurnPart, moreLineCount: number): HTMLElement[] {
  const fields: HTMLElement[] = [];
  if (moreLineCount > 0) fields.push(el('span', 'chat-turn-more', countText(moreLineCount, 'more line', 'more lines')));
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

function createTurnView(part: TurnPart): TurnView {
  const element = el('div', 'chat-turn');
  element.tabIndex = -1;
  const brief = el('div', 'chat-turn-brief');
  const body = el('div', 'chat-turn-body');
  const meta = el('div', 'chat-turn-meta');
  const chevron = button({ variant: 'icon', size: 'small', label: 'Turn details', icon: createLineIcon(CHEVRON_ICON_PATH, '1.6') });
  chevron.classList.add('chat-turn-chevron');
  element.append(brief, body, meta);
  return { element, brief, body, meta, chevron, renderedSegments: [], segmentElements: [], droppedSegmentCount: 0, turnKey: part.turnKey, isOver: false, isFoldable: false };
}

function dropLeadingSegments(view: TurnView, droppedSegmentCount: number): void {
  const newlyDroppedCount = droppedSegmentCount - view.droppedSegmentCount;
  if (newlyDroppedCount <= 0) return;
  for (const droppedElement of view.segmentElements.splice(0, newlyDroppedCount)) droppedElement.remove();
  view.renderedSegments.splice(0, newlyDroppedCount);
  view.droppedSegmentCount = droppedSegmentCount;
}

function syncSegments(view: TurnView, segments: readonly TurnSegment[]): void {
  segments.forEach((segment, index) => {
    const rendered = view.renderedSegments[index];
    if (rendered !== undefined && (rendered.kind === 'text' || (segment.kind === 'tools' && rendered.labels.length === segment.labels.length))) return;
    const segmentElement = renderSegment(segment);
    const existingElement = view.segmentElements[index];
    if (existingElement) existingElement.replaceWith(segmentElement);
    if (!existingElement) view.body.append(segmentElement);
    view.segmentElements[index] = segmentElement;
    view.renderedSegments[index] = segment.kind === 'tools' ? { kind: 'tools', labels: [...segment.labels] } : segment;
  });
}

function updateTurnView(view: TurnView, part: TurnPart): void {
  dropLeadingSegments(view, part.droppedSegmentCount);
  syncSegments(view, part.segments);
  const finalTextIndex = part.segments.findLastIndex((segment) => segment.kind === 'text');
  view.segmentElements.forEach((segmentElement, index) => {
    segmentElement.toggleAttribute('data-before-final', index < finalTextIndex);
  });
  view.turnKey = part.turnKey;
  view.isOver = part.isOver;
  view.element.toggleAttribute('data-over', part.isOver);
  if (!part.isOver) return;
  const digest = digestTurn(part.segments, part.toolCount);
  view.isFoldable = digest.isFoldable;
  view.element.toggleAttribute('data-foldable', digest.isFoldable);
  view.brief.replaceChildren(...(digest.lead === null ? [] : [renderLead(digest.lead)]), ...(digest.asked === null ? [] : [renderAsked(digest.asked)]));
  view.meta.replaceChildren(view.chevron, ...metaFieldsOf(part, digest.moreLineCount));
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
  upsert(parts: readonly ChatPart[]): void;
  remove(partIds: readonly string[]): void;
  keepLast(partIds: readonly string[]): void;
  toggleTurn(turnElement: HTMLElement): void;
}

export function createChatLog(uploadUrlOf: UploadUrlOf, seenTurns: SeenTurns, keepTurnInPlace: (turnElement: HTMLElement, change: () => void) => void): ChatLog {
  const element = el('div', 'chat-log');
  element.setAttribute('role', 'log');
  const elementByPartId = new Map<string, HTMLElement>();
  const turnViewByPartId = new Map<string, TurnView>();
  const isCollapsedByPartId = new Map<string, boolean>();
  const isOpenedByOperatorByPartId = new Map<string, boolean>();
  let newestTurnPartId: string | null = null;

  const showCollapse = (partId: string) => {
    const view = turnViewByPartId.get(partId);
    if (!view) return;
    const isCollapsed = view.isOver && view.isFoldable && (isOpenedByOperatorByPartId.has(partId) ? !isOpenedByOperatorByPartId.get(partId) : (isCollapsedByPartId.get(partId) ?? false));
    view.element.toggleAttribute('data-collapsed', isCollapsed);
    view.chevron.setAttribute('aria-expanded', String(!isCollapsed));
  };
  const decideCollapse = (partId: string, view: TurnView) => {
    if (!view.isOver || isCollapsedByPartId.has(partId)) return;
    isCollapsedByPartId.set(partId, isCollapsedByDefault({ isFoldable: view.isFoldable, isNewest: partId === newestTurnPartId, turnKey: view.turnKey, seenTurnKey: seenTurns.readSeenTurnKey() }));
  };
  const upsertTurn = (part: TurnPart) => {
    const existingView = turnViewByPartId.get(part.id);
    const view = existingView ?? createTurnView(part);
    updateTurnView(view, part);
    if (existingView) return;
    view.element.dataset.partId = part.id;
    turnViewByPartId.set(part.id, view);
    elementByPartId.set(part.id, view.element);
    element.appendChild(view.element);
    const formerNewestPartId = newestTurnPartId;
    newestTurnPartId = part.id;
    if (formerNewestPartId === null) return;
    isCollapsedByPartId.set(formerNewestPartId, true);
    showCollapse(formerNewestPartId);
  };
  const upsertFlat = (part: FlatPart) => {
    const rendered = renderPart(part, uploadUrlOf);
    const existing = elementByPartId.get(part.id);
    elementByPartId.set(part.id, rendered);
    if (existing) {
      existing.replaceWith(rendered);
      return;
    }
    element.appendChild(rendered);
  };
  const upsert = (parts: readonly ChatPart[]) => {
    const touchedTurnPartIds: string[] = [];
    for (const part of parts) {
      if (part.kind !== 'turn') {
        upsertFlat(part);
        continue;
      }
      upsertTurn(part);
      touchedTurnPartIds.push(part.id);
    }
    const seenTurnKeys: number[] = [];
    for (const partId of touchedTurnPartIds) {
      const view = turnViewByPartId.get(partId);
      if (!view) continue;
      decideCollapse(partId, view);
      showCollapse(partId);
      if (view.isOver && view.turnKey !== null) seenTurnKeys.push(view.turnKey);
    }
    if (seenTurnKeys.length > 0) seenTurns.markSeen(Math.max(...seenTurnKeys));
  };
  const remove = (partIds: readonly string[]) => {
    for (const partId of partIds) {
      elementByPartId.get(partId)?.remove();
      elementByPartId.delete(partId);
      turnViewByPartId.delete(partId);
      isCollapsedByPartId.delete(partId);
      isOpenedByOperatorByPartId.delete(partId);
    }
  };
  const toggleTurn = (turnElement: HTMLElement) => {
    const partId = turnElement.dataset.partId;
    const view = partId === undefined ? undefined : turnViewByPartId.get(partId);
    if (partId === undefined || !view || !view.isOver || !view.isFoldable) return;
    keepTurnInPlace(view.element, () => {
      isOpenedByOperatorByPartId.set(partId, view.element.hasAttribute('data-collapsed'));
      showCollapse(partId);
    });
  };
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
  return { element, upsert, remove, keepLast, toggleTurn };
}
