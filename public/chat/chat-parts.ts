import { el } from '../dom-helpers.ts';
import type { BackgroundTaskPart, ChatPart, ChatPartKind, TurnPart } from './chat-part.ts';
import { backgroundTaskKindText, runTimeText } from './chat-parts-core.ts';
import { clock } from '#shared/clock.ts';
import { renderCard } from './chat-cards.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import type { PlanFileRefs } from '../plan/plan-render.ts';
import { openSessionPage } from '../page-registry.ts';
import { findLinkedReaderFile } from '../review/review-reader-core.ts';
import { reviewOf } from '../review/review-store.ts';
import { getSelectedId } from '../review/selection.ts';
import { sessionWorkingDirectoryOf } from '../session-card/card-model.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { createLineIcon, createSvgShape } from '../svg-dom.ts';
import { BRAND_MARK_BRACKETS, BRAND_MARK_LIGHT, BRAND_MARK_VIEWBOX } from '#shared/brand-mark.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { copyButton } from '../ui/copy-button.ts';
import { digestTurn, isInterimReply } from './turn-digest-core.ts';
import type { FilePatch, ToolCallEntry, ToolCallState, TurnSegment } from './turn-digest-core.ts';
import { paintStatusIcon } from '../status-icon.ts';
import type { StatusIcon } from '#shared/state-icons.ts';
import { twoUnitDurationText } from '#shared/display-text.ts';
import { mountPatchDiff, type MountedFileDiff } from '../review/diff-view.ts';

type FlatPartKind = Exclude<ChatPartKind, 'turn'>;
type FlatPart = Exclude<ChatPart, TurnPart>;
type ChatPartByKind = { [Part in FlatPart as Part['kind']]: Part };
type UploadUrlOf = (fileName: string) => string;
type ChatPartRenderer<Kind extends FlatPartKind> = (part: ChatPartByKind[Kind], uploadUrlOf: UploadUrlOf) => HTMLElement;
type ChatPartRendererTable = { [Kind in FlatPartKind]: ChatPartRenderer<Kind> };

interface SegmentItem<Entry> {
  entry: Entry;
  signature: string;
}

interface SegmentList<Entry> {
  items: SegmentItem<Entry>[];
  dropped: number;
  earlier: HTMLElement | null;
}

interface TurnView {
  uploadUrlOf: UploadUrlOf;
  element: HTMLElement;
  brief: HTMLElement;
  body: HTMLElement;
  meta: HTMLElement;
  work: HTMLElement;
  chevron: HTMLButtonElement;
  toolCount: HTMLElement;
  toolNumber: HTMLElement;
  toolWord: HTMLElement;
  diff: HTMLElement;
  diffToggle: HTMLButtonElement;
  mountedDiffs: MountedFileDiff[];
  isDiffOpen: boolean;
  workSegments: SegmentList<WorkEntry>;
  workIsOver: boolean | null;
  bodySegments: SegmentList<HTMLElement | null>;
  part: TurnPart | null;
  hasWork: boolean;
  isOpen: boolean;
}

type ToolsSegment = Extract<TurnSegment, { kind: 'tools' }>;
interface CallRow { element: HTMLDetailsElement; state: ToolCallState }
interface CallsBlock { element: HTMLElement; earlier: HTMLElement; rowByToolUseId: Map<string, CallRow>; uploadUrlOf: UploadUrlOf }
type WorkEntry = { kind: 'calls'; block: CallsBlock } | { kind: 'text'; element: HTMLElement | null };
export type TurnEnd = { pill: HTMLButtonElement; list: HTMLElement };

const CHEVRON_ICON_PATH = 'M6 4l4 4-4 4';
const STATUS_ICON_BY_CALL_STATE: Readonly<Record<ToolCallState, StatusIcon>> = { running: 'working', stopped: 'exited', done: 'complete', failed: 'failed' };

export function renderAttachmentThumbnail(fileName: string, uploadUrlOf: UploadUrlOf): HTMLElement {
  const thumbnail = el('span', 'chat-prompt-thumbnail');
  const image = el('img', 'chat-prompt-thumbnail-image');
  image.alt = '';
  image.loading = 'lazy';
  image.addEventListener('error', () => image.remove(), { once: true });
  image.addEventListener('load', () => {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) thumbnail.style.setProperty('--thumbnail-ratio', String(image.naturalWidth / image.naturalHeight));
  }, { once: true });
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
  const bubble = renderPromptBubble(part.text, part.attachments, uploadUrlOf);
  bubble.hidden = part.isBoardAnswer;
  return bubble;
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

function languageOf(codeBlock: HTMLPreElement): string {
  const languageClass = [...(codeBlock.firstElementChild?.classList ?? [])].find((className) => className.startsWith('language-'));
  return languageClass?.slice('language-'.length) ?? '';
}

function frameCodeBlock(codeBlock: HTMLPreElement): void {
  const frame = el('div', 'chat-code');
  const header = el('div', 'chat-code-header');
  const copy = copyButton({ text: () => codeBlock.textContent ?? '', variant: 'quiet', size: 'small' });
  header.append(el('span', 'chat-code-language', languageOf(codeBlock)), copy.element);
  codeBlock.replaceWith(frame);
  frame.append(header, codeBlock);
}

function changedFileOf(linkedPath: string): { sessionId: string; changedPath: string } | null {
  const sessionId = getSelectedId();
  if (!sessionId) return null;
  const workingDirectory = sessionWorkingDirectoryOf(sessionId) ?? sessionUIs.get(sessionId)?.path ?? null;
  const changedFile = findLinkedReaderFile(reviewOf(sessionId)?.files ?? [], linkedPath, workingDirectory);
  return changedFile ? { sessionId, changedPath: changedFile.path } : null;
}

const CHAT_FILE_REFS: PlanFileRefs = {
  canOpen: (linkedPath) => changedFileOf(linkedPath) !== null,
  open: (linkedPath) => {
    const changed = changedFileOf(linkedPath);
    if (changed) openSessionPage('changes', changed.sessionId, changed.changedPath);
  },
};

export function refreshChatFileRefs(chatRoot: HTMLElement): void {
  for (const fileRef of chatRoot.querySelectorAll<HTMLButtonElement>('button.plan-file-ref[data-path]')) fileRef.disabled = !CHAT_FILE_REFS.canOpen(fileRef.dataset.path ?? '');
}

function renderTextSegment(text: string): HTMLElement {
  const textElement = el('div', 'chat-turn-text');
  const textBody = renderPlanBlocks(parsePlanMarkdown(text), { fileRefs: CHAT_FILE_REFS });
  for (const anchoredHeading of textBody.querySelectorAll('[id]')) anchoredHeading.removeAttribute('id');
  for (const codeBlock of textBody.querySelectorAll<HTMLPreElement>('pre.plan-code')) frameCodeBlock(codeBlock);
  textElement.append(textBody);
  return textElement;
}

function callDurationText(durationMs: number): string {
  if (durationMs < 1000) return `${(durationMs / 1000).toFixed(1)}s`;
  return twoUnitDurationText(Math.floor(durationMs / 1000), { smallestUnit: 's', dropsZeroRemainder: false });
}

function renderCallImages(imageFileNames: readonly string[], uploadUrlOf: UploadUrlOf): HTMLElement {
  const images = el('div', 'chat-turn-call-images');
  for (const fileName of imageFileNames) {
    const fullSizeLink = el('a', 'chat-turn-call-image-link');
    fullSizeLink.href = uploadUrlOf(fileName);
    fullSizeLink.target = '_blank';
    fullSizeLink.rel = 'noopener';
    fullSizeLink.append(renderAttachmentThumbnail(fileName, uploadUrlOf));
    images.append(fullSizeLink);
  }
  return images;
}

function renderCallRow(call: ToolCallEntry, uploadUrlOf: UploadUrlOf): HTMLDetailsElement {
  const row = el('details', 'chat-turn-call');
  row.dataset.state = call.state;
  const hasImages = call.imageFileNames.length > 0;
  row.toggleAttribute('data-has-output', call.outputHead !== null || hasImages);
  row.open = hasImages;
  const summary = el('summary', 'chat-turn-call-row');
  const icon = el('span', 'chat-turn-call-icon');
  paintStatusIcon(icon, STATUS_ICON_BY_CALL_STATE[call.state]);
  summary.append(icon, el('span', 'chat-turn-call-label', call.label), el('span', 'chat-turn-call-time', call.durationMs === null ? '' : callDurationText(call.durationMs)));
  row.append(summary);
  if (hasImages) row.append(renderCallImages(call.imageFileNames, uploadUrlOf));
  if (call.outputHead !== null) row.append(el('pre', 'chat-turn-call-output', call.outputHead));
  return row;
}

function createCallsBlock(uploadUrlOf: UploadUrlOf): CallsBlock {
  const element = el('div', 'chat-turn-calls');
  const earlier = el('div', 'chat-turn-call-note');
  earlier.hidden = true;
  element.append(earlier);
  return { element, earlier, rowByToolUseId: new Map(), uploadUrlOf };
}

function syncCallsBlock(block: CallsBlock, segment: ToolsSegment): void {
  const keptToolUseIds = new Set(segment.calls.map((call) => call.toolUseId));
  for (const [toolUseId, row] of block.rowByToolUseId) {
    if (keptToolUseIds.has(toolUseId)) continue;
    row.element.remove();
    block.rowByToolUseId.delete(toolUseId);
  }
  for (const call of segment.calls) {
    const shownRow = block.rowByToolUseId.get(call.toolUseId);
    if (shownRow?.state === call.state) continue;
    const freshRow = renderCallRow(call, block.uploadUrlOf);
    if (shownRow === undefined) block.element.append(freshRow);
    if (shownRow !== undefined) {
      freshRow.open = shownRow.element.open;
      shownRow.element.replaceWith(freshRow);
    }
    block.rowByToolUseId.set(call.toolUseId, { element: freshRow, state: call.state });
  }
  const unkeptCallCount = segment.callCount - segment.calls.length;
  block.earlier.hidden = unkeptCallCount <= 0;
  block.earlier.textContent = unkeptCallCount > 0 ? `+ ${unkeptCallCount} earlier` : '';
}

function createSegmentList<Entry>(): SegmentList<Entry> {
  return { items: [], dropped: 0, earlier: null };
}

function resetSegmentList<Entry>(list: SegmentList<Entry>, container: HTMLElement): void {
  container.replaceChildren();
  list.items = [];
  list.dropped = 0;
  list.earlier = null;
}

function dropLeadingSegments<Entry>(
  list: SegmentList<Entry>,
  droppedCount: number,
  elementOf: (entry: Entry) => HTMLElement | null,
  earlierContainer?: HTMLElement,
): void {
  const newlyDroppedCount = droppedCount - list.dropped;
  if (newlyDroppedCount > 0) {
    for (const item of list.items.splice(0, newlyDroppedCount)) elementOf(item.entry)?.remove();
    list.dropped = droppedCount;
  }
  if (!earlierContainer || droppedCount === 0) return;
  list.earlier ??= el('div', 'chat-turn-call-note');
  list.earlier.textContent = `+ ${droppedCount} earlier steps`;
  if (earlierContainer.firstChild !== list.earlier) earlierContainer.prepend(list.earlier);
}

function workSignatureOf(segment: TurnSegment): string {
  return segment.kind === 'tools' ? `${segment.callCount}:${segment.settledCount}` : 'text';
}

function workElementOf(entry: WorkEntry): HTMLElement | null {
  return entry.kind === 'calls' ? entry.block.element : entry.element;
}

function workEntryOf(segment: TurnSegment, index: number, part: TurnPart, replyIndex: number, uploadUrlOf: UploadUrlOf): WorkEntry {
  if (segment.kind === 'tools') return { kind: 'calls', block: createCallsBlock(uploadUrlOf) };
  const isShownText = part.isOver && index !== replyIndex;
  return { kind: 'text', element: isShownText ? renderTextSegment(segment.text) : null };
}

function syncWork(view: TurnView, part: TurnPart): void {
  if (view.workIsOver !== part.isOver) resetSegmentList(view.workSegments, view.work);
  view.workIsOver = part.isOver;
  dropLeadingSegments(view.workSegments, part.droppedSegmentCount, workElementOf, view.work);
  const replyIndex = part.isOver ? part.segments.findLastIndex((segment) => segment.kind === 'text') : -1;
  for (const [index, segment] of part.segments.entries()) {
    const signature = workSignatureOf(segment);
    const existing = view.workSegments.items[index];
    if (existing?.signature === signature) continue;
    const entry = existing?.entry ?? workEntryOf(segment, index, part, replyIndex, view.uploadUrlOf);
    if (existing === undefined) {
      view.workSegments.items[index] = { entry, signature };
      const entryElement = workElementOf(entry);
      if (entryElement !== null) view.work.append(entryElement);
    }
    if (existing !== undefined) existing.signature = signature;
    if (entry.kind === 'calls' && segment.kind === 'tools') syncCallsBlock(entry.block, segment);
  }
}

function renderAsked(asked: string): HTMLElement {
  const askedElement = el('p', 'chat-turn-asked');
  askedElement.append(el('span', 'chat-turn-asked-mark', '?'), el('span', 'chat-turn-asked-text', asked));
  return askedElement;
}

function editFactOf(part: TurnPart): HTMLElement {
  const { fileEdits } = part;
  if (!fileEdits.hasLineCounts) return el('span', 'chat-turn-fact', countText(fileEdits.fileCount, 'file', 'files'));
  const lineCounts = el('span', 'chat-turn-fact');
  lineCounts.append(el('span', 'chat-turn-added', `+${fileEdits.added}`), ' ', el('span', 'chat-turn-removed', `-${fileEdits.removed}`));
  return lineCounts;
}

function metaFieldsOf(part: TurnPart, diffToggle: HTMLButtonElement): HTMLElement[] {
  const fields: HTMLElement[] = [];
  if (part.toolCount > 0) fields.push(el('span', 'chat-turn-fact', countText(part.toolCount, 'tool', 'tools')));
  if (part.failedCount > 0) fields.push(el('span', 'chat-turn-fact chat-turn-failed', `${part.failedCount} failed`));
  if (part.thoughtText !== null) fields.push(el('span', 'chat-turn-fact', part.thoughtText));
  if (part.fileEdits.fileCount > 0) fields.push(editFactOf(part));
  if (part.filePatches.length + part.unshownPatchCount > 0) fields.push(diffToggle);
  if (part.durationText !== null) fields.push(el('span', 'chat-turn-time', part.durationText));
  return fields;
}

function closeDiff(view: TurnView): void {
  for (const mountedDiff of view.mountedDiffs) mountedDiff.destroy();
  view.mountedDiffs = [];
  view.diff.replaceChildren();
  view.diff.hidden = true;
}

function mountFilePatch(view: TurnView, filePatch: FilePatch): void {
  const fileHost = el('div', 'chat-turn-diff-file');
  const diffHost = el('div', 'chat-turn-diff-body');
  fileHost.append(el('div', 'chat-turn-diff-name', filePatch.path), diffHost);
  view.diff.append(fileHost);
  mountPatchDiff(diffHost, filePatch.patch, 'unified')
    .then((mountedDiff) => {
      if (!view.isDiffOpen || !diffHost.isConnected) {
        mountedDiff.destroy();
        return;
      }
      view.mountedDiffs.push(mountedDiff);
    })
    .catch((reason: unknown) => diffHost.replaceChildren(el('div', 'chat-turn-call-note', reason instanceof Error ? reason.message : String(reason))));
}

function showDiff(view: TurnView): void {
  view.diffToggle.setAttribute('aria-expanded', String(view.isDiffOpen));
  closeDiff(view);
  if (!view.isDiffOpen || view.part === null) return;
  view.diff.hidden = false;
  for (const filePatch of view.part.filePatches) mountFilePatch(view, filePatch);
  if (view.part.unshownPatchCount > 0) view.diff.append(el('div', 'chat-turn-call-note', `+ ${view.part.unshownPatchCount} not shown`));
}

function createTurnView(uploadUrlOf: UploadUrlOf): TurnView {
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
  const diffToggle = createPressable('chat-turn-diff-toggle', 'Diff');
  diffToggle.setAttribute('aria-expanded', 'false');
  const diff = el('div', 'chat-turn-diff');
  diff.hidden = true;
  element.append(body, brief, meta, work, diff);
  return { uploadUrlOf, element, brief, body, meta, work, chevron, toolCount, toolNumber, toolWord, diff, diffToggle, mountedDiffs: [], isDiffOpen: false, workSegments: createSegmentList(), workIsOver: null, bodySegments: createSegmentList(), part: null, hasWork: false, isOpen: false };
}

function syncBodySegments(view: TurnView, segments: readonly TurnSegment[], isArriving: boolean): void {
  for (const segment of segments.slice(view.bodySegments.items.length)) {
    if (segment.kind === 'tools') {
      view.bodySegments.items.push({ entry: null, signature: segment.kind });
      continue;
    }
    const textElement = renderTextSegment(segment.text);
    view.body.append(textElement);
    view.bodySegments.items.push({ entry: textElement, signature: segment.kind });
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
  if (view.toolCount.parentElement !== view.meta) view.meta.replaceChildren(view.chevron, view.toolCount);
  tickToolNumber(view, part.toolCount);
  view.toolWord.textContent = part.toolCount === 1 ? 'tool call' : 'tool calls';
}

function showEndedRow(view: TurnView, part: TurnPart, turnEnd: TurnEnd | null): void {
  const digest = digestTurn(part.segments, part.toolCount);
  view.hasWork = digest.isFoldable;
  view.element.toggleAttribute('data-foldable', digest.isFoldable);
  view.element.toggleAttribute('data-asks', digest.asked !== null);
  view.brief.replaceChildren(...(digest.asked === null ? [] : [renderAsked(digest.asked)]));
  const metaChildren = [view.chevron, ...metaFieldsOf(part, view.diffToggle)];
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
    resetSegmentList(view.workSegments, view.work);
    view.workIsOver = null;
    return;
  }
  syncWork(view, view.part);
}

function updateTurnView(view: TurnView, part: TurnPart, areNewSegmentsArriving: boolean, turnEnd: TurnEnd | null): void {
  dropLeadingSegments(view.bodySegments, part.droppedSegmentCount, (element) => element);
  syncBodySegments(view, part.segments, areNewSegmentsArriving);
  const finalTextIndex = part.segments.findLastIndex((segment) => segment.kind === 'text');
  view.bodySegments.items.forEach(({ entry: textElement }, index) => {
    const segment = part.segments[index];
    textElement?.toggleAttribute('data-interim', segment?.kind === 'text' && isInterimReply(segment.text));
    textElement?.toggleAttribute('data-before-final', index < finalTextIndex);
    textElement?.toggleAttribute('data-final', index === finalTextIndex);
  });
  view.part = part;
  view.element.toggleAttribute('data-over', part.isOver);
  view.element.toggleAttribute('data-has-tools', part.toolCount > 0);
  if (part.isOver) showEndedRow(view, part, turnEnd);
  if (!part.isOver) showRunningRow(view, part);
  showWork(view);
}

function renderSystemLine(part: Extract<ChatPart, { kind: 'system-line' }>): HTMLElement {
  const line = el('div', 'chat-system-line');
  line.setAttribute('role', 'note');
  const mark = createSvgShape('svg', { class: 'chat-system-mark', viewBox: BRAND_MARK_VIEWBOX, 'aria-hidden': 'true' });
  for (const { d } of BRAND_MARK_BRACKETS) mark.append(createSvgShape('path', { d }));
  mark.append(createSvgShape('path', { class: 'chat-system-mark-light', d: BRAND_MARK_LIGHT }));
  const text = el('span', 'chat-system-text');
  text.append(mark, el('span', 'chat-system-label', part.label));
  line.append(text);
  return line;
}

function renderSkill(part: Extract<ChatPart, { kind: 'skill' }>): HTMLElement {
  const skillRow = el('div', 'chat-subagent chat-skill');
  const row = el('div', 'chat-subagent-row');
  row.append(el('span', 'chat-subagent-dot'), el('span', 'chat-subagent-type', 'Skill'), el('span', 'chat-subagent-task', part.skillName));
  skillRow.append(row);
  return skillRow;
}

function renderRunRow(isRunning: boolean, typeText: string, taskText: string, timeText: string, workElements: readonly HTMLElement[]): HTMLElement {
  const details = el('details', 'chat-subagent');
  details.toggleAttribute('data-running', isRunning);
  const row = el('summary', 'chat-subagent-row');
  row.append(
    el('span', 'chat-subagent-dot'),
    el('span', 'chat-subagent-type', typeText),
    el('span', 'chat-subagent-task', taskText),
    el('span', 'chat-subagent-time', timeText),
    createLineIcon(CHEVRON_ICON_PATH, '1.6'),
  );
  const work = el('div', 'chat-subagent-work');
  work.append(...workElements);
  details.append(row, work);
  return details;
}

function renderBackgroundTask(part: BackgroundTaskPart): HTMLElement {
  const timeText = part.endedAt === null ? '' : runTimeText(part.startedAt, part.endedAt);
  return renderRunRow(part.endedAt === null, backgroundTaskKindText(part.taskType), part.label, timeText, [el('div', 'chat-turn-call', part.command ?? part.label)]);
}

function startedAtOfRunning(part: FlatPart): number | null {
  if (part.kind !== 'background-task') return null;
  return part.endedAt === null ? part.startedAt : null;
}

const RENDERER_BY_PART_KIND = {
  prompt: renderPrompt,
  skill: renderSkill,
  'system-line': renderSystemLine,
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
  element.setAttribute('aria-label', 'Chat');
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
    const view = existingView ?? createTurnView(uploadUrlOf);
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
  const toggleDiff = (turnElement: HTMLElement) => {
    const partId = turnElement.dataset.partId;
    const view = partId === undefined ? undefined : turnViewByPartId.get(partId);
    if (view === undefined) return;
    keepTurnInPlace(view.element, () => {
      view.isDiffOpen = !view.isDiffOpen;
      showDiff(view);
    });
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
    if (event.target.closest('.chat-turn-diff-toggle') !== null) {
      toggleDiff(turnElement);
      return;
    }
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
