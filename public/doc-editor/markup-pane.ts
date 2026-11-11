import { el } from '../dom-helpers.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { isStreamerMode } from '../streamer-mode.ts';
import { CHECK_ICON_PATH, CLOSE_ICON_PATH, COMMUNITY_ICON_PATH, createLineIcon, REDO_ICON_PATH, UNDO_ICON_PATH } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { acceptEveryMark, canRevisePart, isEndNote, isParagraphMark, parseCriticMarkup, resolveMark, revisableTextIn, suggestEdit } from './markup-core.ts';
import { blockStylesOf, inlineRunsOf, markdownImageOf, previewBlocksOf } from './markdown-style-core.ts';
import type { BlockStyle, InlineStyle, PreviewBlock, PreviewBlockKind } from './markdown-style-core.ts';
import type { MarkDecision, MarkSegment, RevisablePart, SourceSelection, SuggestEdit, SuggestRefusal, SuggestRun, TextSegment } from './markup-core.ts';
import { EMPTY_DOC_HISTORY, recordDocEdit, stepDocHistory } from './undo-history-core.ts';
import type { DocHistory, EditKind } from './undo-history-core.ts';
import type { UndoDirection } from '#shared/whiteboard-undo-core.ts';

function commonPrefixLength(before: readonly string[], after: readonly string[]): number {
  const shortest = Math.min(before.length, after.length);
  let matched = 0;
  while (matched < shortest && before[matched] === after[matched]) matched++;
  return matched;
}

function commonSuffixLength(before: readonly string[], after: readonly string[], prefix: number): number {
  const shortest = Math.min(before.length, after.length) - prefix;
  let matched = 0;
  while (matched < shortest && before[before.length - 1 - matched] === after[after.length - 1 - matched]) matched++;
  return matched;
}

export interface MarkupHost {
  baseHash: string | null;
  isBusy: boolean;
  textarea: HTMLTextAreaElement;
  markup: MarkupPane;
  readImage?: (imageSource: string) => Promise<Blob | null>;
}

interface MarkupRow {
  line: HTMLElement;
  margin: HTMLElement;
  notesWithAnchors: Array<{ note: HTMLElement; anchor: HTMLElement }>;
}

interface MarkupPane {
  root: HTMLElement;
  paper: HTMLElement;
  endNotes: HTMLElement;
  markCard: HTMLElement;
  btnAccept: HTMLButtonElement;
  btnReject: HTMLButtonElement;
  btnAddNote: HTMLButtonElement;
  formatButtons: HTMLButtonElement[];
  blockButtons: HTMLButtonElement[];
  formatDivider: HTMLElement;
  blockDivider: HTMLElement;
  btnUndo: HTMLButtonElement;
  btnRedo: HTMLButtonElement;
  btnPreviewAll: HTMLButtonElement;
  previewBlocks: PreviewBlock[];
  previewedBlockKeys: Set<string>;
  imageUrlsBySource: Map<string, Promise<string | null>>;
  missingImageSources: Set<string>;
  noteComposer: HTMLElement;
  noteInput: HTMLInputElement;
  hint: HTMLElement;
  marginResizeObserver: ResizeObserver;
  rowObserver: IntersectionObserver | null;
  listeners: AbortController;
  rowsByElement: Map<Element, MarkupRow>;
  visibleRows: Set<MarkupRow>;
  paintedRows: MarkupRow[];
  selection: SourceSelection | null;
  noteSelection: SourceSelection | null;
  inPlaceEdit: InPlaceEdit | null;
  compositionSelection: SourceSelection | null;
  run: SuggestRun | null;
  history: DocHistory;
  tip: string;
  marks: MarkSegment[];
  elementsByMarkIndex: HTMLElement[][];
  selectedMarkIndex: number | null;
}

type PaperSelection = SourceSelection | 'crosses-mark' | null;
type InPlaceEdit = { mark: MarkSegment; part: RevisablePart; element: HTMLElement };

const PILCROW = String.fromCharCode(0xb6);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const MARGIN_CODE_LABELS: Record<string, string> = { unclear: '?', para: PILCROW };
const MARK_KIND_DESCRIPTIONS: Record<MarkSegment['markKind'], string> = {
  deletion: 'Cut', insertion: 'Add', substitution: 'Change', highlight: 'Note', comment: 'Note',
};
const REFUSAL_TIPS: Record<SuggestRefusal, string> = {
  delimiter: 'That text holds CriticMarkup characters, so typing here cannot become a mark. Nothing changed.',
  swallowed: 'This mark would run into the mark beside it or an unclosed mark earlier in the doc. Nothing changed.',
  nested: 'Marks never nest. Edit text outside a mark, or accept or reject the mark first.',
  nothing: '',
  reserved: 'A note that says only "para" marks a paragraph break, so it cannot be a note. Add a word, or use the para: margin code. Nothing changed.',
};
const NOTHING_TO_PREFIX_TIP = 'The selected lines are already a heading, list, quote, table or code, so there is nothing to prefix. Nothing changed.';
const BACKWARD_DELETES = new Set(['deleteContentBackward', 'deleteByCut']);
const TYPED_INPUTS = new Set(['insertText', 'insertReplacementText', 'insertFromPaste', 'insertFromYank']);
const PARAGRAPH_INPUTS = new Set(['insertParagraph', 'insertLineBreak']);
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const CLOSE_UP_PATH = 'M1 6 Q6 0 11 6 M1 10 Q6 16 11 10';
const DELETE_LOOP_PATH = 'M1 13 C3 4 12 2 11 7 C10 11 4 10 6 5 L9 1';
const PREVIEW_BLOCK_NAMES: Record<PreviewBlockKind, string> = { table: 'table', fence: 'code block', image: 'image' };
const WEB_IMAGE_SOURCE = /^https?:\/\//i;

function svgElement(tag: string, attributes: Record<string, string>) {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [attributeName, value] of Object.entries(attributes)) element.setAttribute(attributeName, value);
  return element;
}

function buildInkFilter() {
  const svg = svgElement('svg', { width: '0', height: '0', 'aria-hidden': 'true', class: 'doc-markup-defs' });
  const filter = svgElement('filter', { id: 'doc-markup-ink' });
  filter.append(
    svgElement('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.05', numOctaves: '2', result: 'grain' }),
    svgElement('feDisplacementMap', { in: 'SourceGraphic', in2: 'grain', scale: '1.6' }),
  );
  svg.append(filter);
  return svg;
}

function buildCheckMark() {
  const svg = svgElement('svg', { viewBox: '0 0 16 16', class: 'doc-markup-check', 'aria-hidden': 'true' });
  svg.append(svgElement('path', { d: 'M2 9 L6 13 L14 3' }));
  return svg;
}

const FORMAT_CONTROLS = [
  { label: 'Bold', action: 'format-bold', delimiter: '**', inlineStyle: 'strong', inputType: 'formatBold', iconPath: 'M4.5 3h4a2.5 2.5 0 0 1 0 5h-4z M4.5 8h4.75a2.5 2.5 0 0 1 0 5H4.5z' },
  { label: 'Italic', action: 'format-italic', delimiter: '*', inlineStyle: 'emphasis', inputType: 'formatItalic', iconPath: 'M7 3h5 M4 13h5 M9.5 3l-3 10' },
  { label: 'Strikethrough', action: 'format-strikethrough', delimiter: '~~', inlineStyle: null, inputType: null, iconPath: 'M2.5 8h11 M11 5.2c0-1.3-1.3-2.2-3-2.2s-3 0.9-3 2.2 M5 10.8c0 1.3 1.3 2.2 3 2.2s3-0.9 3-2.2' },
  { label: 'Code', action: 'format-code', delimiter: '`', inlineStyle: null, inputType: null, iconPath: 'M5.5 4.5L2 8l3.5 3.5 M10.5 4.5L14 8l-3.5 3.5' },
];

const BLOCK_CONTROLS = [
  { label: 'Bullet list', action: 'block-bullet-list', prefixOf: () => '- ', iconPath: 'M3 4.5h0.01M3 8h0.01M3 11.5h0.01 M6 4.5h7.5M6 8h7.5M6 11.5h7.5' },
  { label: 'Numbered list', action: 'block-numbered-list', prefixOf: (lineNumber: number) => `${lineNumber}. `, iconPath: 'M2.5 3.5l1-0.5v3 M2.5 10h1.5l-1.5 2.5h1.5 M7 4.5h6.5M7 8h6.5M7 11.5h6.5' },
  { label: 'Checklist', action: 'block-checklist', prefixOf: () => '- [ ] ', iconPath: 'M2 4.5l1 1l2-2 M2 10.5l1 1l2-2 M7.5 4.5h6M7.5 10.5h6' },
  { label: 'Quote', action: 'block-quote', prefixOf: () => '> ', iconPath: 'M3 4v8 M6.5 5h7M6.5 8h7M6.5 11h5' },
];

function markCardButton(label: string, action: string, iconPath: string) {
  return button({ variant: 'icon', size: 'small', label, action, icon: createLineIcon(iconPath, '1.75') });
}

export function buildMarkupPane(): MarkupPane {
  const btnAccept = markCardButton('Accept', 'accept-mark', CHECK_ICON_PATH);
  const btnReject = markCardButton('Reject', 'reject-mark', CLOSE_ICON_PATH);
  const markCard = el('div', 'doc-markup-float doc-markup-card');
  const btnAddNote = markCardButton('Add note', 'add-note', COMMUNITY_ICON_PATH);
  const formatButtons = FORMAT_CONTROLS.map((control) => markCardButton(control.label, control.action, control.iconPath));
  const blockButtons = BLOCK_CONTROLS.map((control) => markCardButton(control.label, control.action, control.iconPath));
  const formatDivider = el('span', 'doc-markup-card-divider');
  const blockDivider = el('span', 'doc-markup-card-divider');
  markCard.append(btnAccept, btnReject, ...formatButtons, formatDivider, ...blockButtons, blockDivider, btnAddNote);
  const btnUndo = markCardButton('Undo', 'undo-doc-edit', UNDO_ICON_PATH);
  const btnRedo = markCardButton('Redo', 'redo-doc-edit', REDO_ICON_PATH);
  const btnPreviewAll = button({ variant: 'secondary', size: 'small', label: 'Preview all', action: 'preview-all-blocks', hidden: true });
  btnPreviewAll.setAttribute('aria-pressed', 'false');
  const noteInput = el('input', 'plan-control doc-markup-input');
  noteInput.type = 'text';
  noteInput.placeholder = 'Note, or a code like wc: or awk:';
  noteInput.setAttribute('aria-label', 'Note on the selected text');
  const noteComposer = el('div', 'doc-markup-float doc-markup-composer');
  noteComposer.append(noteInput);
  const hint = el('span', 'doc-markup-hint');
  hint.setAttribute('role', 'status');
  const paper = el('div', 'doc-markup-paper');
  paper.spellcheck = false;
  paper.setAttribute('role', 'textbox');
  paper.setAttribute('aria-multiline', 'true');
  paper.setAttribute('aria-label', 'Doc in red pen; edits become marks');
  const endNotes = el('div', 'doc-markup-end');
  const root = el('div', 'doc-markup');
  for (const float of [markCard, noteComposer]) float.hidden = true;
  root.append(buildInkFilter(), paper, endNotes, markCard, noteComposer);
  const pane: MarkupPane = {
    root, paper, endNotes, markCard, btnAccept, btnReject, btnAddNote, formatButtons, blockButtons, formatDivider, blockDivider, btnUndo, btnRedo, btnPreviewAll, previewBlocks: [], previewedBlockKeys: new Set(), imageUrlsBySource: new Map(), missingImageSources: new Set(), noteComposer, noteInput, hint,
    marginResizeObserver: new ResizeObserver(() => placeRowNotes([...pane.visibleRows])),
    rowObserver: null, listeners: new AbortController(), rowsByElement: new Map(), visibleRows: new Set(), paintedRows: [],
    selection: null, noteSelection: null, inPlaceEdit: null, compositionSelection: null, run: null, history: EMPTY_DOC_HISTORY, tip: '',
    marks: [], elementsByMarkIndex: [], selectedMarkIndex: null,
  };
  pane.marginResizeObserver.observe(paper);
  return pane;
}

function forgetImageUrls(pane: MarkupPane) {
  for (const pendingUrl of pane.imageUrlsBySource.values()) void pendingUrl.then((objectUrl) => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
  pane.imageUrlsBySource.clear();
  pane.missingImageSources.clear();
}

export function disposeMarkupPane(pane: MarkupPane) {
  forgetImageUrls(pane);
  pane.marginResizeObserver.disconnect();
  pane.rowObserver?.disconnect();
  pane.listeners.abort();
}

function describeMark(mark: MarkSegment) {
  const parts = [MARK_KIND_DESCRIPTIONS[mark.markKind]];
  if (mark.oldText) parts.push(`"${mark.oldText}"`);
  if (mark.newText) parts.push(`to "${mark.newText}"`);
  if (mark.note) parts.push(`(${[mark.note.code, mark.note.body].filter(Boolean).join(': ')})`);
  return parts.join(' ');
}

function buildPenGlyph(className: string, viewBox: string, strokePath: string) {
  const svg = svgElement('svg', { viewBox, class: `doc-markup-glyph ${className}`, 'aria-hidden': 'true' });
  svg.append(svgElement('path', { d: strokePath }));
  return svg;
}

function isCaseOnlyChange(mark: MarkSegment) {
  const oldLetters = [...mark.oldText];
  const newLetters = [...mark.newText];
  if (mark.oldText === mark.newText || oldLetters.length !== newLetters.length) return false;
  return oldLetters.every((oldLetter, letterIndex) => caseDirectionOf(oldLetter, newLetters[letterIndex]) !== null);
}

function caseDirectionOf(oldLetter: string, newLetter: string): 'same' | 'upper' | 'lower' | null {
  if (oldLetter === newLetter) return 'same';
  if (newLetter === oldLetter.toUpperCase()) return 'upper';
  return newLetter === oldLetter.toLowerCase() ? 'lower' : null;
}

function caseLetterElement(oldLetter: string, newLetter: string): Node {
  const direction = caseDirectionOf(oldLetter, newLetter);
  if (direction === 'same' || direction === null) return document.createTextNode(oldLetter);
  const caseMarked = el('span', 'doc-markup-case', oldLetter);
  caseMarked.dataset.case = direction;
  return caseMarked;
}

function revisable(element: HTMLElement, part: RevisablePart) {
  element.dataset.revise = part;
  return element;
}

function buildInsertionContent(mark: MarkSegment): Node[] {
  if (mark.newText.trim() === '') return [revisable(el('span', 'doc-markup-inserted doc-markup-space', '#'), 'suggestion')];
  if (mark.newText === '.') return [revisable(el('span', 'doc-markup-inserted doc-markup-period', '.'), 'suggestion')];
  return [revisable(el('ins', 'doc-markup-inserted', mark.newText), 'suggestion')];
}

function buildDeletionContent(mark: MarkSegment): Node[] {
  if (mark.oldText.trim() === '') return [buildPenGlyph('doc-markup-closeup', '0 0 12 16', CLOSE_UP_PATH)];
  return [el('del', null, mark.oldText), buildPenGlyph('doc-markup-delete-loop', '0 0 14 14', DELETE_LOOP_PATH)];
}

function buildSubstitutionContent(mark: MarkSegment): Node[] {
  if (isCaseOnlyChange(mark)) {
    const newLetters = [...mark.newText];
    return [...mark.oldText].map((oldLetter, letterIndex) => caseLetterElement(oldLetter, newLetters[letterIndex]));
  }
  if (/\s/.test(mark.oldText.trim())) return [el('del', null, mark.oldText), revisable(el('ins', 'doc-markup-inserted', mark.newText), 'suggestion')];
  const caret = el('span', 'doc-markup-caret', '^');
  caret.append(revisable(el('span', 'doc-markup-caret-label', mark.newText), 'suggestion'));
  return [el('del', null, mark.oldText), caret];
}

function buildMarkContent(mark: MarkSegment): Node[] {
  if (isParagraphMark(mark)) return [el('span', 'doc-markup-pilcrow', PILCROW)];
  switch (mark.markKind) {
    case 'insertion': return buildInsertionContent(mark);
    case 'deletion': return buildDeletionContent(mark);
    case 'substitution': return buildSubstitutionContent(mark);
    case 'highlight': return [el('span', 'doc-markup-underline', mark.oldText)];
    case 'comment': return [el('sup', 'doc-markup-pin', '*')];
  }
}

function buildMarkElement(mark: MarkSegment, markIndex: number) {
  const wrapper = el('span', `doc-markup-mark doc-markup-${mark.markKind}`);
  wrapper.dataset.markIndex = String(markIndex);
  wrapper.contentEditable = 'false';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'button');
  wrapper.setAttribute('aria-label', describeMark(mark));
  wrapper.append(...buildMarkContent(mark));
  return wrapper;
}

function buildMarginNote(mark: MarkSegment, markIndex: number) {
  const note = revisable(el('div', 'doc-markup-note'), 'note');
  note.dataset.code = mark.note?.code ?? '';
  if (mark.note?.code === 'good') note.append(buildCheckMark());
  if (mark.note?.code && mark.note.code !== 'good') note.append(el('span', 'doc-markup-code', MARGIN_CODE_LABELS[mark.note.code] ?? mark.note.code));
  if (mark.note?.body) note.append(el('span', 'doc-markup-note-body', mark.note.body));
  note.dataset.markIndex = String(markIndex);
  return note;
}

function buildEndNote(mark: MarkSegment, markIndex: number) {
  const note = el('div', 'doc-markup-end-note doc-markup-mark');
  note.dataset.markIndex = String(markIndex);
  note.tabIndex = 0;
  note.setAttribute('role', 'button');
  note.setAttribute('aria-label', `End note: ${mark.note?.body ?? ''}`);
  note.append(el('span', 'doc-markup-code', 'End note'), revisable(el('p', 'doc-markup-note-body', mark.note?.body ?? ''), 'note'));
  return note;
}

function buildTextElement(text: string, sourceStart: number, segmentStart: number, inlineStyle?: InlineStyle) {
  const textElement = el('span', 'doc-markup-text', text);
  textElement.dataset.start = String(sourceStart);
  textElement.dataset.segmentStart = String(segmentStart);
  if (inlineStyle) textElement.dataset.inline = inlineStyle;
  return textElement;
}

function buildStyledTextElements(text: string, sourceStart: number, segmentStart: number, block: BlockStyle, startsLine: boolean) {
  const textElements: HTMLElement[] = [];
  let styledUpTo = 0;
  for (const run of inlineRunsOf(text, block, startsLine)) {
    if (run.start > styledUpTo) textElements.push(buildTextElement(text.slice(styledUpTo, run.start), sourceStart + styledUpTo, segmentStart));
    textElements.push(buildTextElement(text.slice(run.start, run.end), sourceStart + run.start, segmentStart, run.style));
    styledUpTo = run.end;
  }
  if (styledUpTo < text.length) textElements.push(buildTextElement(text.slice(styledUpTo), sourceStart + styledUpTo, segmentStart));
  return textElements;
}

function blockStyleByLineStart(source: string) {
  const blockStyles = blockStylesOf(source);
  const styleByLineStart = new Map<number, BlockStyle>();
  let lineStart = 0;
  for (const [lineIndex, lineText] of source.split('\n').entries()) {
    styleByLineStart.set(lineStart, blockStyles[lineIndex] ?? 'plain');
    lineStart += lineText.length + 1;
  }
  return styleByLineStart;
}

function buildRow(lineStart: number, block: BlockStyle): MarkupRow & { row: HTMLElement; block: BlockStyle } {
  const line = el('div', 'doc-markup-line');
  line.dataset.start = String(lineStart);
  line.dataset.block = block;
  const margin = el('div', 'doc-markup-row-margin');
  margin.setAttribute('aria-hidden', 'true');
  margin.contentEditable = 'false';
  const row = el('div', 'doc-markup-row');
  row.append(line, margin);
  return { row, line, margin, notesWithAnchors: [], block };
}

type PaperRow = ReturnType<typeof buildRow>;

function giveMarkLedLinesACaretStop(rows: readonly PaperRow[]) {
  for (const { line } of rows) {
    if (!(line.firstChild instanceof HTMLElement) || line.firstChild.dataset.markIndex === undefined) continue;
    const caretStop = el('span', 'doc-markup-caret-stop', ZERO_WIDTH_SPACE);
    caretStop.dataset.start = line.dataset.start;
    line.prepend(caretStop);
  }
}

function appendTextLines(rows: PaperRow[], segment: TextSegment, styleByLineStart: Map<number, BlockStyle>) {
  let sourceOffset = segment.start;
  segment.text.split('\n').forEach((lineText, lineIndex) => {
    if (lineIndex > 0) rows.push(buildRow(sourceOffset, styleByLineStart.get(sourceOffset) ?? 'plain'));
    const currentRow = rows.at(-1);
    if (lineText && currentRow) currentRow.line.append(...buildStyledTextElements(lineText, sourceOffset, segment.start, currentRow.block, currentRow.line.childElementCount === 0));
    sourceOffset += lineText.length + 1;
  });
}

function buildPreviewToggle(block: PreviewBlock, isPreviewed: boolean) {
  const toggle = button({ variant: 'secondary', size: 'small', label: 'Preview', action: 'preview-block' });
  toggle.classList.add('doc-preview-toggle');
  toggle.contentEditable = 'false';
  toggle.dataset.previewKey = block.key;
  toggle.setAttribute('aria-pressed', String(isPreviewed));
  toggle.setAttribute('aria-label', `Preview ${PREVIEW_BLOCK_NAMES[block.kind]}`);
  return toggle;
}

function imageUrlFor(editor: MarkupHost, imageSource: string): Promise<string | null> {
  const pane = editor.markup;
  const knownUrl = pane.imageUrlsBySource.get(imageSource);
  if (knownUrl) return knownUrl;
  const readImage = editor.readImage;
  const pendingUrl = readImage
    ? readImage(imageSource).then((imageBlob) => imageBlob ? URL.createObjectURL(imageBlob) : null, () => null)
    : Promise.resolve(null);
  void pendingUrl.then((objectUrl) => { if (!objectUrl) pane.missingImageSources.add(imageSource); });
  pane.imageUrlsBySource.set(imageSource, pendingUrl);
  return pendingUrl;
}

function renderPreviewImage(editor: MarkupHost, blockText: string) {
  const image = markdownImageOf(blockText);
  if (!image) return el('p', 'doc-preview-image-missing', blockText);
  return renderImage(editor, image);
}

function renderImage(editor: MarkupHost, image: { alt: string; src: string }): HTMLElement {
  const missingImage = el('p', 'doc-preview-image-missing', `${image.alt || 'Image'} (${image.src})`);
  missingImage.dataset.imageSource = image.src;
  missingImage.dataset.imageAlt = image.alt;
  const picture = el('img', 'doc-preview-image');
  picture.alt = image.alt;
  picture.addEventListener('error', () => picture.replaceWith(missingImage), { once: true });
  if (WEB_IMAGE_SOURCE.test(image.src)) {
    picture.src = image.src;
    return picture;
  }
  void imageUrlFor(editor, image.src).then((objectUrl) => {
    if (!objectUrl) {
      picture.replaceWith(missingImage);
      return;
    }
    picture.src = objectUrl;
  });
  return picture;
}

function renderPreviewBlock(editor: MarkupHost, block: PreviewBlock, blockText: string) {
  if (block.kind === 'image') return renderPreviewImage(editor, blockText);
  return renderPlanBlocks(parsePlanMarkdown(blockText));
}

function buildPreviewRow(editor: MarkupHost, block: PreviewBlock, source: string) {
  const rendered = el('div', 'doc-preview-block');
  rendered.contentEditable = 'false';
  rendered.append(renderPreviewBlock(editor, block, acceptEveryMark(source.slice(block.start, block.end))));
  const margin = el('div', 'doc-markup-row-margin');
  margin.setAttribute('aria-hidden', 'true');
  margin.contentEditable = 'false';
  const row = el('div', 'doc-markup-row');
  row.append(rendered, margin, buildPreviewToggle(block, true));
  return row;
}

function isBlockCrossedByMark(block: PreviewBlock, mark: MarkSegment) {
  const crossesBlockStart = mark.start < block.start && mark.end >= block.start;
  const crossesBlockEnd = mark.start <= block.end && mark.end > block.end;
  return crossesBlockStart || crossesBlockEnd;
}

function blocksClearOfMarks(blocks: PreviewBlock[], marks: readonly MarkSegment[]) {
  let firstReachingMarkIndex = 0;
  return blocks.filter((block) => {
    while ((marks[firstReachingMarkIndex]?.end ?? Infinity) < block.start) firstReachingMarkIndex += 1;
    for (let markIndex = firstReachingMarkIndex; markIndex < marks.length; markIndex += 1) {
      const mark = marks[markIndex];
      if (!mark || mark.start > block.end) return true;
      if (isBlockCrossedByMark(block, mark)) return false;
    }
    return true;
  });
}

function previewedRows(editor: MarkupHost, source: string, rows: PaperRow[]) {
  const pane = editor.markup;
  const shownRows: Array<{ row: HTMLElement; paperRow: PaperRow | null }> = [];
  let blockIndex = 0;
  for (const paperRow of rows) {
    const lineStart = Number(paperRow.line.dataset.start);
    while ((pane.previewBlocks[blockIndex]?.end ?? Infinity) < lineStart) blockIndex += 1;
    const block = pane.previewBlocks[blockIndex];
    const isInBlock = block !== undefined && block.start <= lineStart;
    if (!isInBlock) {
      shownRows.push({ row: paperRow.row, paperRow });
      continue;
    }
    const isBlockStart = block.start === lineStart;
    const isPreviewed = pane.previewedBlockKeys.has(block.key);
    if (isBlockStart && isPreviewed) shownRows.push({ row: buildPreviewRow(editor, block, source), paperRow: null });
    if (isPreviewed) continue;
    if (isBlockStart) paperRow.row.append(buildPreviewToggle(block, false));
    shownRows.push({ row: paperRow.row, paperRow });
  }
  return shownRows;
}

const ROWS_PER_CHUNK = 40;

function fillChunks(paper: HTMLElement, rowElements: HTMLElement[]) {
  const chunkCount = Math.ceil(rowElements.length / ROWS_PER_CHUNK);
  for (const strayNode of [...paper.childNodes]) if (!(strayNode instanceof HTMLElement && strayNode.classList.contains('doc-markup-chunk'))) strayNode.remove();
  while (paper.childElementCount > chunkCount) paper.lastElementChild?.remove();
  while (paper.childElementCount < chunkCount) paper.append(el('div', 'doc-markup-chunk'));
  [...paper.children].forEach((chunk, chunkIndex) => {
    const chunkStart = chunkIndex * ROWS_PER_CHUNK;
    chunk.replaceChildren(...rowElements.slice(chunkStart, chunkStart + ROWS_PER_CHUNK));
  });
}

function copyNotePlacement(paintedRow: MarkupRow, row: MarkupRow) {
  if (row.notesWithAnchors.length === 0) return;
  row.margin.style.minHeight = paintedRow.margin.style.minHeight;
  row.notesWithAnchors.forEach(({ note }, noteIndex) => {
    const paintedNote = paintedRow.notesWithAnchors[noteIndex]?.note;
    if (paintedNote) note.style.top = paintedNote.style.top;
  });
}

function carryNotePlacement(paintedRows: readonly MarkupRow[], rows: readonly MarkupRow[]) {
  const paintedTexts = paintedRows.map(({ line }) => line.textContent ?? '');
  const rowTexts = rows.map(({ line }) => line.textContent ?? '');
  const prefixLength = commonPrefixLength(paintedTexts, rowTexts);
  const suffixLength = commonSuffixLength(paintedTexts, rowTexts, prefixLength);
  const rowShift = paintedRows.length - rows.length;
  rows.forEach((row, rowIndex) => {
    const isInSuffix = rowIndex >= rows.length - suffixLength;
    const paintedRow = paintedRows[isInSuffix ? rowIndex + rowShift : rowIndex];
    if (paintedRow) copyNotePlacement(paintedRow, row);
  });
}

function rowObserverFor(pane: MarkupPane) {
  pane.rowObserver ??= new IntersectionObserver((entries) => {
    const rowsToPlace: MarkupRow[] = [];
    for (const entry of entries) {
      const row = pane.rowsByElement.get(entry.target);
      if (!row) continue;
      if (!entry.isIntersecting) {
        pane.visibleRows.delete(row);
        continue;
      }
      pane.visibleRows.add(row);
      rowsToPlace.push(row);
    }
    placeRowNotes(rowsToPlace);
  }, { root: pane.root.closest('.doc-editor-body'), rootMargin: '600px 0px' });
  return pane.rowObserver;
}

function paintPaper(editor: MarkupHost) {
  const pane = editor.markup;
  pane.inPlaceEdit = null;
  const rowObserver = rowObserverFor(pane);
  rowObserver.disconnect();
  const source = editor.textarea.value;
  const styleByLineStart = blockStyleByLineStart(source);
  const rows = [buildRow(0, styleByLineStart.get(0) ?? 'plain')];
  const endNoteElements: HTMLElement[] = [];
  pane.marks = [];
  pane.elementsByMarkIndex = [];
  pane.rowsByElement.clear();
  pane.visibleRows.clear();
  for (const segment of parseCriticMarkup(source)) {
    if (segment.kind === 'text') {
      appendTextLines(rows, segment, styleByLineStart);
      continue;
    }
    const markIndex = pane.marks.push(segment) - 1;
    if (isEndNote(segment)) {
      const endNote = buildEndNote(segment, markIndex);
      endNoteElements.push(endNote);
      pane.elementsByMarkIndex.push([endNote]);
      continue;
    }
    const currentRow = rows[rows.length - 1];
    const markElement = buildMarkElement(segment, markIndex);
    currentRow?.line.append(markElement);
    pane.elementsByMarkIndex.push([markElement]);
    if (isParagraphMark(segment)) {
      const paragraphRow = buildRow(segment.end, 'plain');
      paragraphRow.line.dataset.break = 'paragraph';
      rows.push(paragraphRow);
      continue;
    }
    if (!segment.note || !currentRow) continue;
    const marginNote = buildMarginNote(segment, markIndex);
    pane.elementsByMarkIndex[markIndex]?.push(marginNote);
    currentRow.margin.append(marginNote);
    currentRow.notesWithAnchors.push({ note: marginNote, anchor: markElement });
  }
  giveMarkLedLinesACaretStop(rows);
  pane.previewBlocks = blocksClearOfMarks(previewBlocksOf(source), pane.marks);
  const shownRows = previewedRows(editor, source, rows);
  carryNotePlacement(pane.paintedRows, rows);
  pane.paintedRows = rows;
  fillChunks(pane.paper, shownRows.map(({ row }) => row));
  for (const { paperRow: markupRow } of shownRows) {
    if (!markupRow || markupRow.notesWithAnchors.length === 0) continue;
    pane.rowsByElement.set(markupRow.row, markupRow);
    rowObserver.observe(markupRow.row);
  }
  pane.endNotes.replaceChildren(...endNoteElements);
  pane.endNotes.hidden = endNoteElements.length === 0;
  pane.selectedMarkIndex = null;
  pane.selection = null;
  pane.noteSelection = null;
}

export function renderMarkup(editor: MarkupHost) {
  editor.markup.run = null;
  editor.markup.tip = '';
  paintPaper(editor);
  paintMarkupTools(editor);
}

function placeRowNotes(rows: MarkupRow[]) {
  const measuredRows = rows.map((row) => {
    const marginTop = row.margin.getBoundingClientRect().top;
    return {
      row,
      measuredNotes: row.notesWithAnchors.map(({ note, anchor }) => ({ note, anchorTop: anchor.getBoundingClientRect().top - marginTop, height: note.offsetHeight })),
    };
  });
  for (const { row, measuredNotes } of measuredRows) {
    let nextFreeTop = 0;
    for (const { note, anchorTop, height } of measuredNotes) {
      const top = Math.max(anchorTop, nextFreeTop);
      note.style.top = `${top}px`;
      nextFreeTop = top + height + 6;
    }
    row.margin.style.minHeight = `${nextFreeTop}px`;
  }
}

function selectedMarkOf(pane: MarkupPane) {
  return pane.selectedMarkIndex === null ? null : pane.marks[pane.selectedMarkIndex] ?? null;
}

function selectMarkIndex(pane: MarkupPane, markIndex: number | null) {
  const previousIndex = pane.selectedMarkIndex;
  for (const element of previousIndex === null ? [] : pane.elementsByMarkIndex[previousIndex] ?? []) element.classList.remove('is-selected');
  pane.selectedMarkIndex = markIndex;
  for (const element of markIndex === null ? [] : pane.elementsByMarkIndex[markIndex] ?? []) element.classList.add('is-selected');
}

function isMarkupLocked(editor: MarkupHost) {
  return editor.isBusy || editor.baseHash === null || editor.textarea.readOnly;
}

function canSuggest(editor: MarkupHost) {
  return !isMarkupLocked(editor) && !isStreamerMode();
}

function placeFloatAbove(pane: MarkupPane, float: HTMLElement, anchorRect: DOMRect | null) {
  float.hidden = anchorRect === null;
  if (!anchorRect) return;
  const rootRect = pane.root.getBoundingClientRect();
  const topAbove = anchorRect.top - rootRect.top - float.offsetHeight - 6;
  const widestLeft = Math.max(0, rootRect.width - float.offsetWidth);
  float.style.top = `${topAbove >= 0 ? topAbove : anchorRect.bottom - rootRect.top + 4}px`;
  const centeredLeft = anchorRect.left + anchorRect.width / 2 - float.offsetWidth / 2 - rootRect.left;
  float.style.left = `${Math.min(Math.max(0, centeredLeft), widestLeft)}px`;
}

function placeFloat(pane: MarkupPane, float: HTMLElement, anchorRect: DOMRect | null) {
  float.hidden = anchorRect === null;
  if (!anchorRect) return;
  float.style.top = `${anchorRect.bottom - pane.root.getBoundingClientRect().top + 4}px`;
}

function selectionRect() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return [...range.getClientRects()].find((rowRect) => rowRect.width > 0) ?? range.getBoundingClientRect();
}

function markAnchorOf(pane: MarkupPane) {
  return pane.selectedMarkIndex === null ? null : pane.elementsByMarkIndex[pane.selectedMarkIndex]?.[0] ?? null;
}

function paintFloats(editor: MarkupHost) {
  const pane = editor.markup;
  const selectedMark = selectedMarkOf(pane);
  const isComposing = pane.noteSelection !== null;
  const markAnchor = isComposing ? null : markAnchorOf(pane);
  const hasRangeSelection = pane.selection !== null && pane.selection.end > pane.selection.start;
  const showsPin = !isComposing && !selectedMark && hasRangeSelection && canSuggest(editor);
  pane.btnAccept.hidden = markAnchor === null;
  pane.btnReject.hidden = markAnchor === null;
  pane.btnAddNote.hidden = markAnchor !== null;
  const selectedSource = pane.selection === null ? '' : editor.textarea.value.slice(pane.selection.start, pane.selection.end);
  const selectionStartElement = currentRange()?.startContainer.parentElement ?? null;
  const selectionStart = pane.selection?.start ?? 0;
  const lineStart = editor.textarea.value.lastIndexOf('\n', selectionStart - 1) + 1;
  const lineBeforeSelection = editor.textarea.value.slice(lineStart, selectionStart);
  const blockAtStart = selectionStartElement?.closest<HTMLElement>('.doc-markup-line')?.dataset.block;
  const tableRowSource = blockAtStart === 'table' ? editor.textarea.value.slice(lineStart).split('\n', 1)[0] : '';
  const tableRunAtStart = inlineRunsOf(tableRowSource, 'plain', false).find((run) => run.start <= lineBeforeSelection.length && lineBeforeSelection.length < run.end);
  const inlineStyleAtStart = selectionStartElement?.closest<HTMLElement>('[data-inline]')?.dataset.inline ?? tableRunAtStart?.style ?? null;
  const opensBeforeSelection = (delimiter: string) => (lineBeforeSelection.split(delimiter).length - 1) % 2 === 1;
  const isSelectionInCode = opensBeforeSelection('`') || blockAtStart === 'fence';
  const canFormatSelection = markAnchor === null && !isSelectionInCode && !selectedSource.trimEnd().includes('\n');
  for (const [controlIndex, formatButton] of pane.formatButtons.entries()) {
    const control = FORMAT_CONTROLS[controlIndex];
    const isAlreadyStyled = (inlineStyleAtStart !== null && control.inlineStyle === inlineStyleAtStart) || (control.delimiter === '~~' && opensBeforeSelection('~~'));
    formatButton.hidden = !canFormatSelection || isAlreadyStyled || selectedSource.includes(control.delimiter[0]);
  }
  pane.formatDivider.hidden = pane.formatButtons.every((formatButton) => formatButton.hidden);
  pane.blockDivider.hidden = markAnchor !== null;
  for (const blockButton of pane.blockButtons) blockButton.hidden = markAnchor !== null;
  const noteAnchorRect = showsPin ? selectionRect() : null;
  placeFloatAbove(pane, pane.markCard, markAnchor?.getBoundingClientRect() ?? noteAnchorRect);
  if (!isComposing) placeFloat(pane, pane.noteComposer, null);
}

function isEveryBlockPreviewed(pane: MarkupPane) {
  return pane.previewBlocks.length > 0 && pane.previewBlocks.every((block) => pane.previewedBlockKeys.has(block.key));
}

export function forgetBlockPreviews(editor: MarkupHost) {
  editor.markup.previewedBlockKeys.clear();
}

export function previewEveryBlockOf(editor: MarkupHost, source: string) {
  for (const block of previewBlocksOf(source)) editor.markup.previewedBlockKeys.add(block.key);
}

export function forgetPreviewImages(editor: MarkupHost) {
  forgetImageUrls(editor.markup);
}

export function retryMissingImages(editor: MarkupHost) {
  const pane = editor.markup;
  if (pane.missingImageSources.size === 0) return;
  for (const imageSource of pane.missingImageSources) pane.imageUrlsBySource.delete(imageSource);
  pane.missingImageSources.clear();
  for (const missingImage of pane.paper.querySelectorAll<HTMLElement>('.doc-preview-image-missing[data-image-source]')) {
    missingImage.replaceWith(renderImage(editor, { alt: missingImage.dataset.imageAlt ?? '', src: missingImage.dataset.imageSource ?? '' }));
  }
}

function repaintPreviews(editor: MarkupHost) {
  paintPaper(editor);
  paintMarkupTools(editor);
}

function toggleBlockPreview(editor: MarkupHost, previewKey: string) {
  saveInPlaceEdit(editor);
  const keys = editor.markup.previewedBlockKeys;
  if (!keys.delete(previewKey)) keys.add(previewKey);
  repaintPreviews(editor);
  editor.markup.paper.querySelector<HTMLElement>(`.doc-preview-toggle[data-preview-key="${CSS.escape(previewKey)}"]`)?.focus({ preventScroll: true });
}

function toggleEveryBlockPreview(editor: MarkupHost) {
  const pane = editor.markup;
  const shouldShowSource = isEveryBlockPreviewed(pane);
  pane.previewedBlockKeys.clear();
  if (!shouldShowSource) for (const block of pane.previewBlocks) pane.previewedBlockKeys.add(block.key);
  repaintPreviews(editor);
}

export function paintMarkupTools(editor: MarkupHost) {
  const pane = editor.markup;
  const isLocked = isMarkupLocked(editor);
  pane.btnPreviewAll.hidden = pane.previewBlocks.length === 0;
  pane.btnPreviewAll.setAttribute('aria-pressed', String(isEveryBlockPreviewed(pane)));
  pane.paper.contentEditable = canSuggest(editor) ? 'true' : 'false';
  pane.btnUndo.disabled = isLocked || pane.history.stacks.undo.length === 0;
  pane.btnRedo.disabled = isLocked || pane.history.stacks.redo.length === 0;
  pane.btnAccept.disabled = isLocked;
  pane.btnReject.disabled = isLocked;
  pane.hint.textContent = pane.tip || markupHintFor(editor);
  pane.hint.dataset.tone = pane.tip ? 'warn' : 'quiet';
  paintFloats(editor);
}

function markupHintFor(editor: MarkupHost) {
  const openMarkCount = editor.markup.marks.length;
  const markCount = `${openMarkCount} open ${openMarkCount === 1 ? 'mark' : 'marks'}.`;
  if (isStreamerMode()) return `Editing marks is off in streamer mode. Accept and Reject still work. ${markCount}`;
  return `Suggesting: edits become red pen; click red text or a note to change it. ${markCount}`;
}

function markIndexOf(element: Element | null) {
  const markElement = element?.closest<HTMLElement>('[data-mark-index]');
  return markElement ? Number(markElement.dataset.markIndex) : null;
}

type SourcePoint = { sourceOffset: number; segmentStart: string | undefined };

function pointAfterChild(pane: MarkupPane, child: ChildNode | undefined, line: HTMLElement): SourcePoint {
  const lineStart = { sourceOffset: Number(line.dataset.start), segmentStart: undefined };
  if (!(child instanceof HTMLElement) || child.classList.contains('doc-markup-caret-stop')) return lineStart;
  const markIndex = markIndexOf(child);
  if (markIndex !== null) return { sourceOffset: caretOffsetBeside(pane.marks[markIndex]) ?? lineStart.sourceOffset, segmentStart: undefined };
  return { sourceOffset: Number(child.dataset.start) + (child.textContent?.length ?? 0), segmentStart: child.dataset.segmentStart };
}

function caretOffsetBeside(mark: MarkSegment | undefined) {
  if (!mark) return undefined;
  return isParagraphMark(mark) ? mark.start : mark.end;
}

function pointAtLineEdge(pane: MarkupPane, line: HTMLElement | null | undefined, edge: 'start' | 'end'): SourcePoint | null {
  if (!line) return null;
  if (edge === 'end') return pointAfterChild(pane, line.lastChild ?? undefined, line);
  const firstChild = line.firstChild;
  if (firstChild instanceof HTMLElement && firstChild.classList.contains('doc-markup-text')) return { sourceOffset: Number(firstChild.dataset.start), segmentStart: firstChild.dataset.segmentStart };
  return { sourceOffset: Number(line.dataset.start), segmentStart: undefined };
}

function linesWithin(node: Node): HTMLElement[] {
  if (!(node instanceof HTMLElement)) return [];
  if (node.classList.contains('doc-markup-line')) return [node];
  return [...node.querySelectorAll<HTMLElement>('.doc-markup-line')];
}

function sourcePointAt(pane: MarkupPane, node: Node, offset: number): SourcePoint | null {
  const element = node instanceof Element ? node : node.parentElement;
  const markIndex = markIndexOf(element);
  if (markIndex !== null) {
    const sourceOffset = caretOffsetBeside(pane.marks[markIndex]);
    return sourceOffset === undefined ? null : { sourceOffset, segmentStart: undefined };
  }
  const caretStop = element?.closest<HTMLElement>('.doc-markup-caret-stop');
  if (caretStop) return { sourceOffset: Number(caretStop.dataset.start), segmentStart: undefined };
  const textSpan = element?.closest<HTMLElement>('.doc-markup-text');
  if (textSpan) {
    const isTextNode = node.nodeType === Node.TEXT_NODE;
    const spanOffset = isTextNode ? offset : offset === 0 ? 0 : textSpan.textContent?.length ?? 0;
    return { sourceOffset: Number(textSpan.dataset.start) + spanOffset, segmentStart: textSpan.dataset.segmentStart };
  }
  const line = element?.closest<HTMLElement>('.doc-markup-line');
  if (line && node === line) return pointAfterChild(pane, line.childNodes[offset - 1], line);
  if (line || !(node instanceof Element) || !pane.paper.contains(node)) return null;
  const children = [...node.childNodes];
  const linesBefore = children.slice(0, offset).flatMap(linesWithin);
  if (linesBefore.length > 0) return pointAtLineEdge(pane, linesBefore.at(-1), 'end');
  return pointAtLineEdge(pane, children.slice(offset).flatMap(linesWithin)[0], 'start');
}

function readPaperSelection(pane: MarkupPane, range: AbstractRange | null): PaperSelection {
  if (!range || !pane.paper.contains(range.startContainer) || !pane.paper.contains(range.endContainer)) return null;
  const start = sourcePointAt(pane, range.startContainer, range.startOffset);
  const end = sourcePointAt(pane, range.endContainer, range.endOffset);
  if (!start || !end) return null;
  if (range.collapsed) return { start: start.sourceOffset, end: start.sourceOffset };
  const endsAtLineStart = range.endOffset === 0 && range.endContainer instanceof HTMLElement && range.endContainer.classList.contains('doc-markup-line');
  const holdsMark = pane.marks.some((mark) => mark.start < end.sourceOffset && mark.end > start.sourceOffset);
  if (start.segmentStart !== undefined && endsAtLineStart && !holdsMark) return { start: start.sourceOffset, end: Math.max(start.sourceOffset, end.sourceOffset - 1) };
  if (start.segmentStart === undefined || start.segmentStart !== end.segmentStart) return 'crosses-mark';
  return { start: start.sourceOffset, end: end.sourceOffset };
}

function currentRange() {
  const selection = window.getSelection();
  return selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
}

function caretPointFor(pane: MarkupPane, sourceOffset: number): { node: Node; offset: number } | { after: Node } | null {
  for (const textSpan of pane.paper.querySelectorAll<HTMLElement>('.doc-markup-text')) {
    const spanStart = Number(textSpan.dataset.start);
    const textNode = textSpan.firstChild;
    if (textNode && spanStart <= sourceOffset && sourceOffset <= spanStart + (textSpan.textContent?.length ?? 0)) return { node: textNode, offset: sourceOffset - spanStart };
  }
  const caretStop = [...pane.paper.querySelectorAll<HTMLElement>('.doc-markup-caret-stop')].find((candidate) => Number(candidate.dataset.start) === sourceOffset);
  if (caretStop?.firstChild) return { node: caretStop.firstChild, offset: 1 };
  const line = [...pane.paper.querySelectorAll<HTMLElement>('.doc-markup-line')].find((candidate) => Number(candidate.dataset.start) === sourceOffset);
  if (line) return { node: line, offset: 0 };
  const markIndex = pane.marks.findIndex((mark) => mark.end === sourceOffset);
  const markElement = markIndex === -1 ? null : pane.elementsByMarkIndex[markIndex]?.[0];
  return markElement && pane.paper.contains(markElement) ? { after: markElement } : null;
}

function placeCaret(pane: MarkupPane, sourceOffset: number, endSourceOffset = sourceOffset) {
  const point = caretPointFor(pane, sourceOffset);
  const endPoint = caretPointFor(pane, endSourceOffset);
  const selection = window.getSelection();
  if (!point || !endPoint || !selection) return;
  const range = document.createRange();
  if ('after' in point) range.setStartAfter(point.after);
  if ('node' in point) range.setStart(point.node, point.offset);
  if ('after' in endPoint) range.setEndAfter(endPoint.after);
  if ('node' in endPoint) range.setEnd(endPoint.node, endPoint.offset);
  pane.paper.focus({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(range);
}

function writeDocText(editor: MarkupHost, nextText: string) {
  editor.textarea.value = nextText;
  editor.textarea.dispatchEvent(new Event('input'));
}

function rememberDocEdit(editor: MarkupHost, edit: { kind: EditKind; after: string; caretBefore: number; caretAfter: number }) {
  editor.markup.history = recordDocEdit(editor.markup.history, { ...edit, before: editor.textarea.value, atMs: Date.now() });
  writeDocText(editor, edit.after);
}

function showTip(editor: MarkupHost, refusal: SuggestRefusal) {
  editor.markup.tip = REFUSAL_TIPS[refusal];
  paintMarkupTools(editor);
}

function applySuggestion(editor: MarkupHost, edit: SuggestEdit) {
  const pane = editor.markup;
  const outcome = suggestEdit(editor.textarea.value, edit, pane.run);
  if (outcome.kind === 'refused') {
    showTip(editor, outcome.reason);
    return;
  }
  rememberDocEdit(editor, { kind: edit.kind === 'revise' ? 'note' : edit.kind, after: outcome.source, caretBefore: edit.selection.start, caretAfter: outcome.caret });
  pane.tip = '';
  paintPaper(editor);
  placeCaret(pane, outcome.caret);
  pane.run = outcome.run;
  pane.selection = { start: outcome.caret, end: outcome.caret };
  paintMarkupTools(editor);
}

function formatSelection(editor: MarkupHost, delimiter: string) {
  const pane = editor.markup;
  const selection = pane.selection;
  if (!selection) return;
  const selectedText = editor.textarea.value.slice(selection.start, selection.end);
  const words = selectedText.trim();
  if (words === '') return;
  const wordsStart = selection.start + selectedText.indexOf(words);
  pane.history = { ...pane.history, openGroup: null };
  applySuggestion(editor, { kind: 'type', selection: { start: wordsStart, end: wordsStart + words.length }, text: `${delimiter}${words}${delimiter}` });
  pane.history = { ...pane.history, openGroup: null };
  pane.run = null;
}

const ORDERED_ITEM_NUMBER = /^[ \t]*(\d{1,9})[.)][ \t]/;

function prefixableLineStartsOf(source: string, selection: SourceSelection) {
  const sourceLines = source.split('\n');
  const acceptedLines = sourceLines.map(acceptEveryMark);
  const blockStyles = blockStylesOf(acceptedLines.join('\n'));
  const lineStarts: number[] = [];
  let numberAbove = 0;
  let lineStart = 0;
  for (const [lineIndex, line] of sourceLines.entries()) {
    const lineEnd = lineStart + line.length;
    const isSelected = lineEnd >= selection.start && lineStart < selection.end;
    const isPlainProse = blockStyles[lineIndex] === 'plain' && acceptedLines[lineIndex].trim() !== '';
    const isFirstPrefixedLine = isSelected && isPlainProse && lineStarts.length === 0;
    if (isFirstPrefixedLine) numberAbove = Number(ORDERED_ITEM_NUMBER.exec(acceptedLines[lineIndex - 1] ?? '')?.[1] ?? 0);
    if (isSelected && isPlainProse) lineStarts.push(lineStart);
    lineStart = lineEnd + 1;
  }
  return { lineStarts, numberAbove };
}

function prefixSelectedLines(editor: MarkupHost, prefixOf: (lineNumber: number) => string) {
  const pane = editor.markup;
  const selection = pane.selection;
  if (!selection) return;
  const { lineStarts, numberAbove } = prefixableLineStartsOf(editor.textarea.value, selection);
  let prefixedSource = editor.textarea.value;
  for (const [lineIndex, lineStart] of [...lineStarts.entries()].reverse()) {
    const outcome = suggestEdit(prefixedSource, { kind: 'type', selection: { start: lineStart, end: lineStart }, text: prefixOf(numberAbove + lineIndex + 1) }, null);
    if (outcome.kind === 'refused') {
      showTip(editor, outcome.reason);
      return;
    }
    prefixedSource = outcome.source;
  }
  if (prefixedSource === editor.textarea.value) {
    pane.tip = NOTHING_TO_PREFIX_TIP;
    paintMarkupTools(editor);
    return;
  }
  rememberDocEdit(editor, { kind: 'note', after: prefixedSource, caretBefore: selection.start, caretAfter: lineStarts[0] });
  renderMarkup(editor);
  placeCaret(pane, lineStarts[0]);
  pane.selection = { start: lineStarts[0], end: lineStarts[0] };
  paintMarkupTools(editor);
}

function withoutCaretStops(text: string) {
  return text.replaceAll(ZERO_WIDTH_SPACE, '');
}

function typedTextOf(event: InputEvent) {
  return withoutCaretStops(event.data ?? event.dataTransfer?.getData('text/plain') ?? '');
}

function copyWithoutCaretStops(event: ClipboardEvent) {
  const copiedText = window.getSelection()?.toString() ?? '';
  if (!copiedText.includes(ZERO_WIDTH_SPACE) || !event.clipboardData) return;
  event.preventDefault();
  event.clipboardData.setData('text/plain', withoutCaretStops(copiedText));
}

function editFor(event: InputEvent, selection: SourceSelection): SuggestEdit | null {
  if (TYPED_INPUTS.has(event.inputType)) return { kind: 'type', selection, text: typedTextOf(event) };
  if (PARAGRAPH_INPUTS.has(event.inputType)) return { kind: 'paragraph', selection };
  if (BACKWARD_DELETES.has(event.inputType)) return { kind: 'delete', selection, direction: 'backward' };
  if (event.inputType === 'deleteContentForward') return { kind: 'delete', selection, direction: 'forward' };
  return null;
}

function selectionForInput(pane: MarkupPane, event: InputEvent): PaperSelection {
  const targetRange = event.inputType === 'insertReplacementText' ? event.getTargetRanges()[0] ?? null : null;
  return readPaperSelection(pane, targetRange ?? currentRange());
}

function isInsideInPlaceEdit(pane: MarkupPane, target: EventTarget | null) {
  return pane.inPlaceEdit !== null && target instanceof Node && pane.inPlaceEdit.element.contains(target);
}

function onBeforeInput(editor: MarkupHost, event: InputEvent) {
  if (isInsideInPlaceEdit(editor.markup, event.target)) return;
  if (event.inputType === 'insertCompositionText') return;
  event.preventDefault();
  if (!canSuggest(editor)) return;
  const selection = selectionForInput(editor.markup, event);
  if (selection === 'crosses-mark') {
    showTip(editor, 'nested');
    return;
  }
  const formatControlIndex = FORMAT_CONTROLS.findIndex((control) => control.inputType === event.inputType);
  const isFormatOffered = formatControlIndex !== -1 && !editor.markup.markCard.hidden && !editor.markup.formatButtons[formatControlIndex].hidden;
  if (isFormatOffered) {
    formatSelection(editor, FORMAT_CONTROLS[formatControlIndex].delimiter);
    return;
  }
  const edit = selection ? editFor(event, selection) : null;
  if (edit) applySuggestion(editor, edit);
}

function onCompositionEnd(editor: MarkupHost, event: CompositionEvent) {
  const pane = editor.markup;
  const selection = pane.compositionSelection;
  pane.compositionSelection = null;
  paintPaper(editor);
  if (!selection || !canSuggest(editor)) {
    paintMarkupTools(editor);
    return;
  }
  applySuggestion(editor, { kind: 'type', selection, text: event.data });
}

function trackPaperSelection(editor: MarkupHost) {
  const pane = editor.markup;
  const range = currentRange();
  if (!range || !pane.paper.contains(range.startContainer) || pane.inPlaceEdit) return;
  const selection = readPaperSelection(pane, range);
  pane.selection = selection === 'crosses-mark' ? null : selection;
  const isCaretAtRunEnd = pane.selection !== null && pane.selection.start === pane.run?.markEnd && pane.selection.end === pane.run.markEnd;
  if (!isCaretAtRunEnd) pane.run = null;
  pane.tip = '';
  const isTypingInPaper = document.activeElement === pane.paper && pane.selection !== null;
  if (isTypingInPaper) selectMarkIndex(pane, null);
  paintMarkupTools(editor);
}

function decideSelectedMark(editor: MarkupHost, decision: MarkDecision) {
  const selectedMark = selectedMarkOf(editor.markup);
  if (!selectedMark || isMarkupLocked(editor)) return;
  if (saveInPlaceEdit(editor) === 'refused') return;
  const mark = editor.markup.marks.find((candidate) => candidate.start === selectedMark.start);
  if (!mark) return;
  rememberDocEdit(editor, { kind: 'decide', after: resolveMark(editor.textarea.value, mark, decision), caretBefore: mark.start, caretAfter: mark.start });
  renderMarkup(editor);
}

export function isMarkupTextField(pane: MarkupPane, target: EventTarget | null) {
  return target === pane.noteInput || isInsideInPlaceEdit(pane, target);
}

export function stepDocEdit(editor: MarkupHost, direction: UndoDirection) {
  if (isMarkupLocked(editor) || editor.markup.inPlaceEdit) return;
  const stepped = stepDocHistory(editor.markup.history, direction, editor.textarea.value);
  if (!stepped) return;
  editor.markup.history = stepped.history;
  writeDocText(editor, stepped.source);
  renderMarkup(editor);
  placeCaret(editor.markup, stepped.caret);
}

export function forgetDocHistory(editor: MarkupHost) {
  editor.markup.history = EMPTY_DOC_HISTORY;
}

function openNoteComposer(editor: MarkupHost) {
  const pane = editor.markup;
  if (!pane.selection || pane.selection.end === pane.selection.start) return;
  const anchorRect = selectionRect();
  pane.noteSelection = pane.selection;
  pane.noteInput.value = '';
  placeFloat(pane, pane.noteComposer, anchorRect);
  paintMarkupTools(editor);
  pane.noteInput.focus();
}

function inPlaceEditElementOf(pane: MarkupPane, markIndex: number) {
  const elements = pane.elementsByMarkIndex[markIndex] ?? [];
  const parts = elements.flatMap((element) => [element, ...element.querySelectorAll<HTMLElement>('[data-revise]')]);
  return parts.find((part) => part.dataset.revise === 'suggestion') ?? parts.find((part) => part.dataset.revise === 'note') ?? null;
}

function placeCaretAtPoint(element: HTMLElement, clickPoint: { x: number; y: number } | null) {
  const selection = window.getSelection();
  if (!selection) return;
  const pointRange = clickPoint ? document.caretRangeFromPoint?.(clickPoint.x, clickPoint.y) ?? null : null;
  const range = pointRange && element.contains(pointRange.startContainer) ? pointRange : document.createRange();
  if (range !== pointRange) {
    range.selectNodeContents(element);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function startInPlaceEdit(editor: MarkupHost, element: HTMLElement, clickPoint: { x: number; y: number } | null) {
  const pane = editor.markup;
  const markIndex = markIndexOf(element);
  const mark = markIndex === null ? null : pane.marks[markIndex] ?? null;
  const part = element.dataset.revise === 'note' ? 'note' : 'suggestion';
  if (!mark || markIndex === null || !canRevisePart(mark, part) || !canSuggest(editor) || pane.inPlaceEdit) return false;
  selectMarkIndex(pane, markIndex);
  pane.selection = null;
  pane.noteSelection = null;
  pane.inPlaceEdit = { mark, part, element };
  const revisableText = revisableTextIn(editor.textarea.value, mark, part);
  const isShownAsWritten = element.textContent === revisableText;
  if (!isShownAsWritten) element.textContent = revisableText;
  element.classList.add('doc-markup-editing');
  element.contentEditable = 'plaintext-only';
  element.focus({ preventScroll: true });
  placeCaretAtPoint(element, isShownAsWritten ? clickPoint : null);
  paintMarkupTools(editor);
  return true;
}

function cancelInPlaceEdit(editor: MarkupHost) {
  if (!editor.markup.inPlaceEdit) return;
  editor.markup.inPlaceEdit = null;
  paintPaper(editor);
  paintMarkupTools(editor);
}

function saveInPlaceEdit(editor: MarkupHost): 'kept' | 'refused' {
  const pane = editor.markup;
  const inPlaceEdit = pane.inPlaceEdit;
  if (!inPlaceEdit) return 'kept';
  const revisedText = inPlaceEdit.element.textContent ?? '';
  if (revisedText === revisableTextIn(editor.textarea.value, inPlaceEdit.mark, inPlaceEdit.part) || !canSuggest(editor)) {
    cancelInPlaceEdit(editor);
    return 'kept';
  }
  pane.inPlaceEdit = null;
  const { mark, part } = inPlaceEdit;
  const sourceBefore = editor.textarea.value;
  applySuggestion(editor, { kind: 'revise', selection: { start: mark.start, end: mark.end }, mark, part, text: revisedText });
  if (editor.textarea.value !== sourceBefore) return 'kept';
  paintPaper(editor);
  paintMarkupTools(editor);
  return 'refused';
}

function selectInPlaceEditText(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

const FIELD_EDGE_BY_KEY: Record<string, 'start' | 'end'> = { Home: 'start', ArrowUp: 'start', PageUp: 'start', End: 'end', ArrowDown: 'end', PageDown: 'end' };
const FIELD_EDGE_BY_CONTROL_KEY: Record<string, 'start' | 'end'> = { p: 'start', e: 'end', n: 'end' };
const isMacCaretKeymap = navigator.userAgent.includes('Mac');
const FIELD_EDGE_BY_META_KEY: Record<string, 'start' | 'end'> = { ArrowLeft: 'start', ArrowRight: 'end' };

function fieldEdgeOf(event: KeyboardEvent): 'start' | 'end' | null {
  if (event.metaKey) return FIELD_EDGE_BY_META_KEY[event.key] ?? FIELD_EDGE_BY_KEY[event.key] ?? null;
  if (event.ctrlKey && isMacCaretKeymap) return FIELD_EDGE_BY_CONTROL_KEY[event.key.toLowerCase()] ?? FIELD_EDGE_BY_KEY[event.key] ?? null;
  return FIELD_EDGE_BY_KEY[event.key] ?? null;
}

function stepDirectionOf(event: KeyboardEvent): 'backward' | 'forward' | null {
  if (event.key === 'ArrowLeft' || (isMacCaretKeymap && event.ctrlKey && event.key.toLowerCase() === 'b')) return 'backward';
  if (event.key === 'ArrowRight' || (isMacCaretKeymap && event.ctrlKey && event.key.toLowerCase() === 'f')) return 'forward';
  return null;
}

function isStepLeavingField(element: HTMLElement, event: KeyboardEvent) {
  const stepDirection = stepDirectionOf(event);
  const selection = window.getSelection();
  if (!stepDirection || !selection || selection.rangeCount === 0) return false;
  if (!event.shiftKey && !selection.isCollapsed) return false;
  const caretOffset = textOffsetInField(element, selection.focusNode ?? element, selection.focusOffset);
  if (stepDirection === 'backward') return caretOffset === 0;
  return caretOffset === (element.textContent ?? '').length;
}

function moveCaretToFieldEdge(element: HTMLElement, edge: 'start' | 'end', isExtending: boolean) {
  const selection = window.getSelection();
  if (!selection) return;
  const edgeOffset = edge === 'start' ? 0 : element.childNodes.length;
  if (isExtending && selection.anchorNode) {
    selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, element, edgeOffset);
    return;
  }
  selection.collapse(element, edgeOffset);
}

function keepCaretInField(event: KeyboardEvent, element: HTMLElement) {
  const edge = fieldEdgeOf(event);
  if (edge) {
    event.preventDefault();
    moveCaretToFieldEdge(element, edge, event.shiftKey);
    return;
  }
  if (isWordStep(event)) {
    event.preventDefault();
    stepWordInField(element, event);
    return;
  }
  if (isStepLeavingField(element, event)) event.preventDefault();
}

function isWordStep(event: KeyboardEvent) {
  return (event.altKey || event.ctrlKey) && (event.key === 'ArrowLeft' || event.key === 'ArrowRight');
}

function textOffsetInField(element: HTMLElement, node: Node, offset: number) {
  const textBeforePoint = document.createRange();
  textBeforePoint.selectNodeContents(element);
  textBeforePoint.setEnd(node, offset);
  return textBeforePoint.toString().length;
}

function pointAtTextOffset(element: HTMLElement, textOffset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remainingOffset = textOffset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remainingOffset <= length) return { node, offset: remainingOffset };
    remainingOffset -= length;
  }
  return { node: element, offset: element.childNodes.length };
}

function wordStepTarget(text: string, caretOffset: number, direction: 'backward' | 'forward') {
  const words = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)].filter((segment) => segment.isWordLike);
  if (direction === 'forward') return words.map((word) => word.index + word.segment.length).find((wordEnd) => wordEnd > caretOffset) ?? text.length;
  return words.map((word) => word.index).findLast((wordStart) => wordStart < caretOffset) ?? 0;
}

function stepWordInField(element: HTMLElement, event: KeyboardEvent) {
  const selection = window.getSelection();
  if (!selection?.focusNode || !selection.anchorNode) return;
  const direction = event.key === 'ArrowLeft' ? 'backward' : 'forward';
  const caretOffset = textOffsetInField(element, selection.focusNode, selection.focusOffset);
  const target = pointAtTextOffset(element, wordStepTarget(element.textContent ?? '', caretOffset, direction));
  if (event.shiftKey) {
    selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, target.node, target.offset);
    return;
  }
  selection.collapse(target.node, target.offset);
}

function onInPlaceEditKeydown(editor: MarkupHost, event: KeyboardEvent, element: HTMLElement) {
  keepCaretInField(event, element);
  const isSelectAll = (event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 'a' || event.code === 'KeyA');
  if (isSelectAll) {
    event.stopPropagation();
    event.preventDefault();
    selectInPlaceEditText(element);
    return;
  }
  if (event.key === 'Escape') {
    event.stopPropagation();
    event.preventDefault();
    cancelInPlaceEdit(editor);
    return;
  }
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  saveInPlaceEdit(editor);
}

function startInPlaceEditFromKeyboard(editor: MarkupHost, event: KeyboardEvent) {
  const markIndex = markIndexOf(event.target instanceof Element ? event.target : null);
  const revisableElement = markIndex === null ? null : inPlaceEditElementOf(editor.markup, markIndex);
  if (revisableElement && startInPlaceEdit(editor, revisableElement, null)) event.preventDefault();
}

function onSurfaceKeydown(editor: MarkupHost, event: KeyboardEvent) {
  const inPlaceEdit = editor.markup.inPlaceEdit;
  if (inPlaceEdit && isInsideInPlaceEdit(editor.markup, event.target)) {
    onInPlaceEditKeydown(editor, event, inPlaceEdit.element);
    return;
  }
  if (event.key === 'F2') {
    startInPlaceEditFromKeyboard(editor, event);
    return;
  }
  const pane = editor.markup;
  const hasToolbarForRange = !pane.markCard.hidden && pane.selection !== null && pane.selection.end > pane.selection.start;
  if (hasToolbarForRange && event.target === pane.paper && event.key === 'Tab' && !event.shiftKey) {
    event.preventDefault();
    pane.markCard.querySelector<HTMLElement>('button:not([hidden])')?.focus();
    return;
  }
  if (hasToolbarForRange && event.target === pane.paper && event.key === 'Escape') {
    event.preventDefault();
    window.getSelection()?.collapseToEnd();
    return;
  }
  const caret = pane.selection;
  const hasPlainStep = event.target === pane.paper && !event.shiftKey && !event.altKey && !event.metaKey && caret !== null && caret.start === caret.end;
  const stepDirection = hasPlainStep ? stepDirectionOf(event) : null;
  const crossedParagraphMark = stepDirection === null ? undefined : pane.marks.find((mark) => isParagraphMark(mark) && (stepDirection === 'backward' ? mark.end : mark.start) === caret?.start);
  if (crossedParagraphMark) {
    event.preventDefault();
    placeCaret(pane, stepDirection === 'backward' ? crossedParagraphMark.start : crossedParagraphMark.end);
    return;
  }
  if (event.key !== 'Enter' || !selectMarkAt(editor, event.target)) return;
  event.preventDefault();
  editor.markup.btnAccept.focus();
}

function closeNoteComposer(editor: MarkupHost) {
  editor.markup.noteSelection = null;
  paintMarkupTools(editor);
}

function submitNote(editor: MarkupHost) {
  const pane = editor.markup;
  const selection = pane.noteSelection;
  pane.noteSelection = null;
  if (!canSuggest(editor) || !selection) {
    paintMarkupTools(editor);
    return;
  }
  applySuggestion(editor, { kind: 'note', selection, body: pane.noteInput.value });
}

function selectMarkAt(editor: MarkupHost, target: EventTarget | null) {
  if (isInsideInPlaceEdit(editor.markup, target)) return true;
  const markIndex = markIndexOf(target instanceof Element ? target : null);
  if (markIndex === null) return false;
  selectMarkIndex(editor.markup, editor.markup.marks[markIndex] ? markIndex : null);
  editor.markup.selection = null;
  editor.markup.noteSelection = null;
  paintMarkupTools(editor);
  return true;
}

export function wireMarkupPane(editor: MarkupHost) {
  const pane = editor.markup;
  const { signal } = pane.listeners;
  for (const surface of [pane.paper, pane.endNotes]) {
    surface.addEventListener('focusin', (event) => { selectMarkAt(editor, event.target); });
    surface.addEventListener('click', (event) => {
      const revisableElement = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-revise]') : null;
      if (revisableElement && startInPlaceEdit(editor, revisableElement, { x: event.clientX, y: event.clientY })) return;
      selectMarkAt(editor, event.target);
    });
    surface.addEventListener('keydown', (event) => onSurfaceKeydown(editor, event));
    surface.addEventListener('focusout', (event) => { if (isInsideInPlaceEdit(pane, event.target)) saveInPlaceEdit(editor); });
  }
  pane.paper.addEventListener('mousedown', (event) => {
    if (event.target instanceof Element && event.target.closest('.doc-preview-toggle')) event.preventDefault();
  });
  pane.paper.addEventListener('click', (event) => {
    const toggle = event.target instanceof Element ? event.target.closest<HTMLElement>('.doc-preview-toggle') : null;
    if (toggle?.dataset.previewKey) toggleBlockPreview(editor, toggle.dataset.previewKey);
  });
  pane.btnPreviewAll.addEventListener('click', () => toggleEveryBlockPreview(editor));
  pane.paper.addEventListener('beforeinput', (event) => onBeforeInput(editor, event));
  pane.paper.addEventListener('copy', copyWithoutCaretStops);
  pane.paper.addEventListener('compositionstart', (event) => {
    if (isInsideInPlaceEdit(pane, event.target)) return;
    const selection = readPaperSelection(pane, currentRange());
    pane.compositionSelection = selection === 'crosses-mark' ? null : selection;
  });
  pane.paper.addEventListener('compositionend', (event) => {
    if (isInsideInPlaceEdit(pane, event.target)) return;
    onCompositionEnd(editor, event);
  });
  pane.paper.addEventListener('input', (event) => {
    if (isInsideInPlaceEdit(pane, event.target)) {
      paintFloats(editor);
      return;
    }
    if (event instanceof InputEvent && event.isComposing) return;
    paintPaper(editor);
    paintMarkupTools(editor);
  });
  pane.paper.addEventListener('drop', (event) => event.preventDefault());
  document.addEventListener('selectionchange', () => {
    if (pane.compositionSelection) return;
    trackPaperSelection(editor);
  }, { signal });
  pane.markCard.addEventListener('mousedown', (event) => event.preventDefault());
  pane.markCard.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    pane.paper.focus({ preventScroll: true });
    if (pane.selection) placeCaret(pane, pane.selection.start, pane.selection.end);
  });
  pane.btnAddNote.addEventListener('click', () => openNoteComposer(editor));
  for (const [controlIndex, formatButton] of pane.formatButtons.entries()) formatButton.addEventListener('click', () => formatSelection(editor, FORMAT_CONTROLS[controlIndex].delimiter));
  for (const [controlIndex, blockButton] of pane.blockButtons.entries()) blockButton.addEventListener('click', () => prefixSelectedLines(editor, BLOCK_CONTROLS[controlIndex].prefixOf));
  pane.btnUndo.addEventListener('click', () => stepDocEdit(editor, 'undo'));
  pane.btnRedo.addEventListener('click', () => stepDocEdit(editor, 'redo'));
  pane.noteInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeNoteComposer(editor);
      return;
    }
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    submitNote(editor);
  });
  pane.noteInput.addEventListener('blur', () => { if (pane.noteSelection) closeNoteComposer(editor); });
  pane.btnAccept.addEventListener('click', () => decideSelectedMark(editor, 'accept'));
  pane.btnReject.addEventListener('click', () => decideSelectedMark(editor, 'reject'));
}
