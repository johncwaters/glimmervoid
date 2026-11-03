import { el, writeClipboardText } from '../dom-helpers.ts';
import { isStreamerMode } from '../streamer-mode.ts';
import { button } from '../ui/button.ts';
import { agentPromptFor, isEndNote, parseCriticMarkup, resolveMark, suggestEdit } from './markup-core.ts';
import type { MarkDecision, MarkSegment, SourceSelection, SuggestEdit, SuggestRefusal, SuggestRun, TextSegment } from './markup-core.ts';

export interface MarkupHost {
  docPath: string;
  baseHash: string | null;
  hasUnsavedChanges: boolean;
  isBusy: boolean;
  textarea: HTMLTextAreaElement;
  markup: MarkupPane;
  showStatus: (text: string, tone?: 'quiet' | 'warn') => void;
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
  markCardText: HTMLElement;
  btnAccept: HTMLButtonElement;
  btnReject: HTMLButtonElement;
  btnAddNote: HTMLButtonElement;
  noteComposer: HTMLElement;
  noteInput: HTMLInputElement;
  btnCopyPrompt: HTMLButtonElement;
  hint: HTMLElement;
  marginResizeObserver: ResizeObserver;
  rowObserver: IntersectionObserver | null;
  listeners: AbortController;
  rowsByElement: Map<Element, MarkupRow>;
  visibleRows: Set<MarkupRow>;
  selection: SourceSelection | null;
  noteSelection: SourceSelection | null;
  compositionSelection: SourceSelection | null;
  run: SuggestRun | null;
  tip: string;
  marks: MarkSegment[];
  elementsByMarkIndex: HTMLElement[][];
  selectedMarkIndex: number | null;
}

type PaperSelection = SourceSelection | 'crosses-mark' | null;

const MARGIN_CODE_LABELS: Record<string, string> = { unclear: '?', para: String.fromCharCode(0xb6) };
const MARK_KIND_DESCRIPTIONS: Record<MarkSegment['markKind'], string> = {
  deletion: 'Cut', insertion: 'Add', substitution: 'Change', highlight: 'Note', comment: 'Note',
};
const REFUSAL_TIPS: Record<SuggestRefusal, string> = {
  delimiter: 'That text holds CriticMarkup characters, so typing here cannot become a mark. Nothing changed.',
  swallowed: 'This mark would run into the mark beside it or an unclosed mark earlier in the doc. Nothing changed.',
  nested: 'Marks never nest. Edit text outside a mark, or accept or reject the mark first.',
  nothing: '',
};
const BACKWARD_DELETES = new Set(['deleteContentBackward', 'deleteByCut']);
const TYPED_INPUTS = new Set(['insertText', 'insertReplacementText', 'insertFromPaste', 'insertFromYank']);
const PARAGRAPH_INPUTS = new Set(['insertParagraph', 'insertLineBreak']);
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

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

export function buildMarkupPane(): MarkupPane {
  const btnAccept = button({ variant: 'primary', size: 'small', label: 'Accept', action: 'accept-mark' });
  const btnReject = button({ variant: 'danger', size: 'small', label: 'Reject', action: 'reject-mark' });
  const markCardText = el('p', 'doc-markup-card-text');
  const markCardActions = el('div', 'doc-markup-card-actions');
  markCardActions.append(btnAccept, btnReject);
  const markCard = el('div', 'doc-markup-float doc-markup-card');
  markCard.append(markCardText, markCardActions);
  const btnAddNote = button({ variant: 'secondary', size: 'small', label: 'Add note', action: 'add-note' });
  btnAddNote.classList.add('doc-markup-float');
  const noteInput = el('input', 'plan-control doc-markup-input');
  noteInput.type = 'text';
  noteInput.placeholder = 'Note, or a code like wc: or awk:';
  noteInput.setAttribute('aria-label', 'Note on the selected text');
  const noteComposer = el('div', 'doc-markup-float doc-markup-composer');
  noteComposer.append(noteInput);
  const btnCopyPrompt = button({ variant: 'secondary', size: 'small', label: 'Copy agent prompt', action: 'copy-agent-prompt' });
  const hint = el('span', 'doc-markup-hint');
  hint.setAttribute('role', 'status');
  const tools = el('div', 'doc-markup-tools');
  tools.append(hint, btnCopyPrompt);
  const paper = el('div', 'doc-markup-paper');
  paper.spellcheck = false;
  paper.setAttribute('role', 'textbox');
  paper.setAttribute('aria-multiline', 'true');
  paper.setAttribute('aria-label', 'Doc in red pen; edits become marks');
  const endNotes = el('div', 'doc-markup-end');
  const root = el('div', 'doc-markup');
  root.hidden = true;
  for (const float of [markCard, btnAddNote, noteComposer]) float.hidden = true;
  root.append(buildInkFilter(), tools, paper, endNotes, markCard, btnAddNote, noteComposer);
  const pane: MarkupPane = {
    root, paper, endNotes, markCard, markCardText, btnAccept, btnReject, btnAddNote, noteComposer, noteInput, btnCopyPrompt, hint,
    marginResizeObserver: new ResizeObserver(() => placeRowNotes([...pane.visibleRows])),
    rowObserver: null, listeners: new AbortController(), rowsByElement: new Map(), visibleRows: new Set(),
    selection: null, noteSelection: null, compositionSelection: null, run: null, tip: '',
    marks: [], elementsByMarkIndex: [], selectedMarkIndex: null,
  };
  pane.marginResizeObserver.observe(paper);
  return pane;
}

export function disposeMarkupPane(pane: MarkupPane) {
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

function buildMarkElement(mark: MarkSegment, markIndex: number) {
  const wrapper = el('span', `doc-markup-mark doc-markup-${mark.markKind}`);
  wrapper.dataset.markIndex = String(markIndex);
  wrapper.contentEditable = 'false';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'button');
  wrapper.setAttribute('aria-label', describeMark(mark));
  if (mark.oldText && mark.markKind !== 'highlight') wrapper.append(el('del', null, mark.oldText));
  if (mark.markKind === 'highlight') wrapper.append(el('span', 'doc-markup-underline', mark.oldText));
  if (mark.newText) {
    const caret = el('ruby', 'doc-markup-caret', '^');
    caret.append(el('rt', null, mark.newText));
    wrapper.append(caret);
  }
  if (mark.markKind === 'comment') wrapper.append(el('sup', 'doc-markup-pin', '*'));
  return wrapper;
}

function buildMarginNote(mark: MarkSegment) {
  const note = el('div', 'doc-markup-note');
  note.dataset.code = mark.note?.code ?? '';
  if (mark.note?.code === 'good') note.append(buildCheckMark());
  if (mark.note?.code && mark.note.code !== 'good') note.append(el('span', 'doc-markup-code', MARGIN_CODE_LABELS[mark.note.code] ?? mark.note.code));
  if (mark.note?.body) note.append(el('span', 'doc-markup-note-body', mark.note.body));
  return note;
}

function buildEndNote(mark: MarkSegment, markIndex: number) {
  const note = el('div', 'doc-markup-end-note doc-markup-mark');
  note.dataset.markIndex = String(markIndex);
  note.tabIndex = 0;
  note.setAttribute('role', 'button');
  note.setAttribute('aria-label', `End note: ${mark.note?.body ?? ''}`);
  note.append(el('span', 'doc-markup-code', 'End note'), el('p', 'doc-markup-note-body', mark.note?.body ?? ''));
  return note;
}

function buildTextElement(text: string, sourceStart: number, segmentStart: number) {
  const textElement = el('span', 'doc-markup-text', text);
  textElement.dataset.start = String(sourceStart);
  textElement.dataset.segmentStart = String(segmentStart);
  return textElement;
}

function buildRow(lineStart: number): MarkupRow & { row: HTMLElement } {
  const line = el('div', 'doc-markup-line');
  line.dataset.start = String(lineStart);
  const margin = el('div', 'doc-markup-row-margin');
  margin.setAttribute('aria-hidden', 'true');
  margin.contentEditable = 'false';
  const row = el('div', 'doc-markup-row');
  row.append(line, margin);
  return { row, line, margin, notesWithAnchors: [] };
}

function appendTextLines(rows: Array<MarkupRow & { row: HTMLElement }>, segment: TextSegment) {
  let sourceOffset = segment.start;
  segment.text.split('\n').forEach((lineText, lineIndex) => {
    if (lineIndex > 0) rows.push(buildRow(sourceOffset));
    if (lineText) rows.at(-1)?.line.append(buildTextElement(lineText, sourceOffset, segment.start));
    sourceOffset += lineText.length + 1;
  });
}

const ROWS_PER_CHUNK = 40;

function chunkRows(rowElements: HTMLElement[]) {
  const chunks: HTMLElement[] = [];
  for (let chunkStart = 0; chunkStart < rowElements.length; chunkStart += ROWS_PER_CHUNK) {
    const chunk = el('div', 'doc-markup-chunk');
    chunk.append(...rowElements.slice(chunkStart, chunkStart + ROWS_PER_CHUNK));
    chunks.push(chunk);
  }
  return chunks;
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
  const rowObserver = rowObserverFor(pane);
  rowObserver.disconnect();
  const rows = [buildRow(0)];
  const endNoteElements: HTMLElement[] = [];
  pane.marks = [];
  pane.elementsByMarkIndex = [];
  pane.rowsByElement.clear();
  pane.visibleRows.clear();
  for (const segment of parseCriticMarkup(editor.textarea.value)) {
    if (segment.kind === 'text') {
      appendTextLines(rows, segment);
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
    if (!segment.note || !currentRow) continue;
    const marginNote = buildMarginNote(segment);
    pane.elementsByMarkIndex[markIndex]?.push(marginNote);
    currentRow.margin.append(marginNote);
    currentRow.notesWithAnchors.push({ note: marginNote, anchor: markElement });
  }
  pane.paper.replaceChildren(...chunkRows(rows.map(({ row }) => row)));
  for (const markupRow of rows) {
    if (markupRow.notesWithAnchors.length === 0) continue;
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

function placeFloat(pane: MarkupPane, float: HTMLElement, anchorRect: DOMRect | null) {
  float.hidden = anchorRect === null;
  if (!anchorRect) return;
  float.style.top = `${anchorRect.top - pane.root.getBoundingClientRect().top}px`;
}

function selectionRect() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  return selection.getRangeAt(0).getBoundingClientRect();
}

function paintFloats(editor: MarkupHost) {
  const pane = editor.markup;
  const selectedMark = selectedMarkOf(pane);
  const markAnchor = pane.selectedMarkIndex === null ? null : pane.elementsByMarkIndex[pane.selectedMarkIndex]?.[0] ?? null;
  pane.markCardText.textContent = selectedMark ? describeMark(selectedMark) : '';
  placeFloat(pane, pane.markCard, markAnchor?.getBoundingClientRect() ?? null);
  const isComposing = pane.noteSelection !== null;
  const hasRangeSelection = pane.selection !== null && pane.selection.end > pane.selection.start;
  const showsPin = !isComposing && !selectedMark && hasRangeSelection && canSuggest(editor);
  placeFloat(pane, pane.btnAddNote, showsPin ? selectionRect() : null);
  if (!isComposing) placeFloat(pane, pane.noteComposer, null);
}

export function paintMarkupTools(editor: MarkupHost) {
  const pane = editor.markup;
  const isLocked = isMarkupLocked(editor);
  pane.paper.contentEditable = canSuggest(editor) ? 'true' : 'false';
  pane.btnAccept.disabled = isLocked;
  pane.btnReject.disabled = isLocked;
  pane.btnCopyPrompt.disabled = isLocked || editor.hasUnsavedChanges || pane.marks.length === 0;
  pane.hint.textContent = pane.tip || markupHintFor(editor);
  pane.hint.dataset.tone = pane.tip ? 'warn' : 'quiet';
  paintFloats(editor);
}

function markupHintFor(editor: MarkupHost) {
  const openMarkCount = editor.markup.marks.length;
  const markCount = `${openMarkCount} open ${openMarkCount === 1 ? 'mark' : 'marks'}.`;
  if (isStreamerMode()) return `Editing marks is off in streamer mode. Accept and Reject still work. ${markCount}`;
  if (editor.hasUnsavedChanges && openMarkCount > 0) return `Suggesting: edits become red pen. ${markCount} Save before copying the agent prompt.`;
  return `Suggesting: edits become red pen. ${markCount}`;
}

function markIndexOf(element: Element | null) {
  const markElement = element?.closest<HTMLElement>('.doc-markup-mark');
  return markElement ? Number(markElement.dataset.markIndex) : null;
}

type SourcePoint = { sourceOffset: number; segmentStart: string | undefined };

function pointAfterChild(pane: MarkupPane, child: ChildNode | undefined, line: HTMLElement): SourcePoint {
  const lineStart = { sourceOffset: Number(line.dataset.start), segmentStart: undefined };
  if (!(child instanceof HTMLElement)) return lineStart;
  const markIndex = markIndexOf(child);
  if (markIndex !== null) return { sourceOffset: pane.marks[markIndex]?.end ?? lineStart.sourceOffset, segmentStart: undefined };
  return { sourceOffset: Number(child.dataset.start) + (child.textContent?.length ?? 0), segmentStart: child.dataset.segmentStart };
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
    const mark = pane.marks[markIndex];
    return mark ? { sourceOffset: mark.end, segmentStart: undefined } : null;
  }
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
  const markIndex = pane.marks.findIndex((mark) => mark.end === sourceOffset);
  const markElement = markIndex === -1 ? null : pane.elementsByMarkIndex[markIndex]?.[0];
  if (markElement && pane.paper.contains(markElement)) return { after: markElement };
  const line = [...pane.paper.querySelectorAll<HTMLElement>('.doc-markup-line')].find((candidate) => Number(candidate.dataset.start) === sourceOffset);
  return line ? { node: line, offset: 0 } : null;
}

function placeCaret(pane: MarkupPane, sourceOffset: number) {
  const point = caretPointFor(pane, sourceOffset);
  const selection = window.getSelection();
  if (!point || !selection) return;
  const range = document.createRange();
  if ('after' in point) range.setStartAfter(point.after);
  if ('node' in point) range.setStart(point.node, point.offset);
  range.collapse(true);
  pane.paper.focus({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(range);
}

function writeDocText(editor: MarkupHost, nextText: string) {
  editor.textarea.value = nextText;
  editor.textarea.dispatchEvent(new Event('input'));
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
  writeDocText(editor, outcome.source);
  pane.tip = '';
  paintPaper(editor);
  placeCaret(pane, outcome.caret);
  pane.run = outcome.run;
  pane.selection = { start: outcome.caret, end: outcome.caret };
  paintMarkupTools(editor);
}

function typedTextOf(event: InputEvent) {
  return event.data ?? event.dataTransfer?.getData('text/plain') ?? '';
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

function onBeforeInput(editor: MarkupHost, event: InputEvent) {
  if (event.inputType === 'insertCompositionText') return;
  event.preventDefault();
  if (!canSuggest(editor)) return;
  const selection = selectionForInput(editor.markup, event);
  if (selection === 'crosses-mark') {
    showTip(editor, 'nested');
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
  if (!range || !pane.paper.contains(range.startContainer)) return;
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
  const mark = selectedMarkOf(editor.markup);
  if (!mark || isMarkupLocked(editor)) return;
  writeDocText(editor, resolveMark(editor.textarea.value, mark, decision));
  renderMarkup(editor);
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

function closeNoteComposer(editor: MarkupHost) {
  editor.markup.noteSelection = null;
  paintMarkupTools(editor);
}

function submitNote(editor: MarkupHost) {
  const pane = editor.markup;
  const selection = pane.noteSelection;
  pane.noteSelection = null;
  if (!selection || !canSuggest(editor)) {
    paintMarkupTools(editor);
    return;
  }
  applySuggestion(editor, { kind: 'note', selection, body: pane.noteInput.value });
}

async function copyAgentPrompt(editor: MarkupHost) {
  const pendingWrite = writeClipboardText(agentPromptFor(editor.docPath, editor.markup.marks.length));
  if (!pendingWrite) {
    editor.showStatus('This browser blocks clipboard writes here.', 'warn');
    return;
  }
  try {
    await pendingWrite;
    editor.showStatus('Agent prompt copied');
  } catch {
    editor.showStatus('Could not copy the agent prompt', 'warn');
  }
}

function selectMarkAt(editor: MarkupHost, target: EventTarget | null) {
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
    surface.addEventListener('click', (event) => { selectMarkAt(editor, event.target); });
    surface.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !selectMarkAt(editor, event.target)) return;
      event.preventDefault();
      pane.btnAccept.focus();
    });
  }
  pane.paper.addEventListener('beforeinput', (event) => onBeforeInput(editor, event));
  pane.paper.addEventListener('compositionstart', () => {
    const selection = readPaperSelection(pane, currentRange());
    pane.compositionSelection = selection === 'crosses-mark' ? null : selection;
  });
  pane.paper.addEventListener('compositionend', (event) => onCompositionEnd(editor, event));
  pane.paper.addEventListener('input', (event) => {
    if (event instanceof InputEvent && event.isComposing) return;
    paintPaper(editor);
    paintMarkupTools(editor);
  });
  pane.paper.addEventListener('drop', (event) => event.preventDefault());
  document.addEventListener('selectionchange', () => {
    if (pane.root.hidden || pane.compositionSelection) return;
    trackPaperSelection(editor);
  }, { signal });
  for (const float of [pane.btnAddNote, pane.markCard]) float.addEventListener('mousedown', (event) => event.preventDefault());
  pane.btnAddNote.addEventListener('click', () => openNoteComposer(editor));
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
  pane.btnCopyPrompt.addEventListener('click', () => { void copyAgentPrompt(editor); });
}
