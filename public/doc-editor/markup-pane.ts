import { el, writeClipboardText } from '../dom-helpers.ts';
import { isStreamerMode } from '../streamer-mode.ts';
import { button } from '../ui/button.ts';
import { agentPromptFor, applyOperatorMark, canApplyOperatorMark, holdsMarkupDelimiter, isEndNote, parseCriticMarkup, resolveMark } from './markup-core.ts';
import type { MarkDecision, MarkSegment, OperatorMarkAction, SourceSelection, TextSegment } from './markup-core.ts';

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
  operatorText: HTMLInputElement;
  toolButtons: Map<OperatorMarkAction, HTMLButtonElement>;
  btnAccept: HTMLButtonElement;
  btnReject: HTMLButtonElement;
  btnCopyPrompt: HTMLButtonElement;
  hint: HTMLElement;
  marginResizeObserver: ResizeObserver;
  rowObserver: IntersectionObserver | null;
  rowsByElement: Map<Element, MarkupRow>;
  visibleRows: Set<MarkupRow>;
  selection: SourceSelection | null;
  marks: MarkSegment[];
  elementsByMarkIndex: HTMLElement[][];
  selectedMarkIndex: number | null;
}

const OPERATOR_MARK_LABELS: ReadonlyArray<readonly [OperatorMarkAction, string]> = [
  ['strike', 'Strike'], ['insert', 'Insert'], ['replace', 'Replace'], ['note', 'Note'],
];
const MARGIN_CODE_LABELS: Record<string, string> = { unclear: '?', para: String.fromCharCode(0xb6) };
const MARK_KIND_DESCRIPTIONS: Record<MarkSegment['markKind'], string> = {
  deletion: 'Cut', insertion: 'Add', substitution: 'Change', highlight: 'Note', comment: 'Note',
};
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
  const operatorText = el('input', 'plan-control doc-markup-input');
  operatorText.type = 'text';
  operatorText.placeholder = 'New text or note';
  operatorText.setAttribute('aria-label', 'New text or note');
  const toolButtons = new Map(OPERATOR_MARK_LABELS.map(([action, label]) => [action, button({ variant: 'secondary', size: 'small', label })] as const));
  const btnAccept = button({ variant: 'primary', size: 'small', label: 'Accept', action: 'accept-mark' });
  const btnReject = button({ variant: 'danger', size: 'small', label: 'Reject', action: 'reject-mark' });
  const btnCopyPrompt = button({ variant: 'secondary', size: 'small', label: 'Copy agent prompt', action: 'copy-agent-prompt' });
  const hint = el('span', 'doc-markup-hint');
  hint.setAttribute('role', 'status');
  const tools = el('div', 'doc-markup-tools');
  const addGroup = el('div', 'doc-markup-group');
  addGroup.append(operatorText, ...toolButtons.values());
  const decideGroup = el('div', 'doc-markup-group');
  decideGroup.append(btnAccept, btnReject);
  tools.append(addGroup, decideGroup, btnCopyPrompt, hint);
  const paper = el('div', 'doc-markup-paper');
  const endNotes = el('div', 'doc-markup-end');
  const root = el('div', 'doc-markup');
  root.hidden = true;
  root.append(buildInkFilter(), tools, paper, endNotes);
  const pane: MarkupPane = {
    root, paper, endNotes, operatorText, toolButtons, btnAccept, btnReject, btnCopyPrompt, hint,
    marginResizeObserver: new ResizeObserver(() => placeRowNotes([...pane.visibleRows])),
    rowObserver: null, rowsByElement: new Map(), visibleRows: new Set(),
    selection: null, marks: [], elementsByMarkIndex: [], selectedMarkIndex: null,
  };
  pane.marginResizeObserver.observe(paper);
  return pane;
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

function buildRow(): MarkupRow & { row: HTMLElement } {
  const line = el('div', 'doc-markup-line');
  const margin = el('div', 'doc-markup-row-margin');
  margin.setAttribute('aria-hidden', 'true');
  const row = el('div', 'doc-markup-row');
  row.append(line, margin);
  return { row, line, margin, notesWithAnchors: [] };
}

function appendTextLines(rows: Array<MarkupRow & { row: HTMLElement }>, segment: TextSegment) {
  let sourceOffset = segment.start;
  segment.text.split('\n').forEach((lineText, lineIndex) => {
    if (lineIndex > 0) rows.push(buildRow());
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

export function renderMarkup(editor: MarkupHost) {
  const pane = editor.markup;
  const rowObserver = rowObserverFor(pane);
  rowObserver.disconnect();
  const rows = [buildRow()];
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

export function paintMarkupTools(editor: MarkupHost) {
  const pane = editor.markup;
  const isLocked = isMarkupLocked(editor);
  const canAddMarks = !isLocked && !isStreamerMode();
  const source = editor.textarea.value;
  for (const [action, button] of pane.toolButtons) button.disabled = !canAddMarks || !canApplyOperatorMark(source, action, pane.selection, pane.operatorText.value);
  pane.operatorText.disabled = !canAddMarks;
  const hasSelectedMark = pane.selectedMarkIndex !== null;
  pane.btnAccept.disabled = isLocked || !hasSelectedMark;
  pane.btnReject.disabled = isLocked || !hasSelectedMark;
  pane.btnCopyPrompt.disabled = isLocked || editor.hasUnsavedChanges || pane.marks.length === 0;
  pane.hint.textContent = markupHintFor(editor);
}

function markupHintFor(editor: MarkupHost) {
  const pane = editor.markup;
  const selectedMark = selectedMarkOf(pane);
  const openMarkCount = pane.marks.length;
  if (selectedMark) return describeMark(selectedMark);
  if (isStreamerMode()) return 'Adding marks is off in streamer mode.';
  if (isSelectionBlockedByDelimiter(editor)) return 'That text holds CriticMarkup characters. Change it in Edit mode.';
  if (editor.hasUnsavedChanges && openMarkCount > 0) return `${openMarkCount} open marks. Save before copying the agent prompt.`;
  if (openMarkCount > 0) return `${openMarkCount} open marks. Click one to accept or reject it.`;
  return 'Select text to strike, replace or note it; click between words to insert.';
}

function isSelectionBlockedByDelimiter(editor: MarkupHost) {
  const selection = editor.markup.selection;
  if (!selection) return false;
  return holdsMarkupDelimiter(editor.textarea.value.slice(selection.start, selection.end)) || holdsMarkupDelimiter(editor.markup.operatorText.value);
}

function sourceOffsetAt(node: Node, offset: number): { segmentStart: string | undefined; sourceOffset: number } | null {
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const span = node.parentElement?.closest<HTMLElement>('.doc-markup-text');
  if (!span) return null;
  return { segmentStart: span.dataset.segmentStart, sourceOffset: Number(span.dataset.start) + offset };
}

function readSourceSelection(pane: MarkupPane): SourceSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!pane.paper.contains(range.commonAncestorContainer)) return null;
  const start = sourceOffsetAt(range.startContainer, range.startOffset);
  const end = sourceOffsetAt(range.endContainer, range.endOffset);
  if (!start || !end || start.segmentStart !== end.segmentStart) return null;
  return { start: start.sourceOffset, end: end.sourceOffset };
}

function replaceDocText(editor: MarkupHost, nextText: string) {
  editor.textarea.value = nextText;
  editor.textarea.dispatchEvent(new Event('input'));
  renderMarkup(editor);
}

function decideSelectedMark(editor: MarkupHost, decision: MarkDecision) {
  const mark = selectedMarkOf(editor.markup);
  if (!mark || isMarkupLocked(editor)) return;
  replaceDocText(editor, resolveMark(editor.textarea.value, mark, decision));
}

function addOperatorMark(editor: MarkupHost, action: OperatorMarkAction) {
  const pane = editor.markup;
  if (!pane.selection || !canApplyOperatorMark(editor.textarea.value, action, pane.selection, pane.operatorText.value)) return;
  const markedSource = applyOperatorMark(editor.textarea.value, action, pane.selection, pane.operatorText.value);
  if (markedSource === null) {
    editor.showStatus('An unclosed CriticMarkup mark earlier in the doc would swallow this one. Fix it in Edit mode.', 'warn');
    return;
  }
  replaceDocText(editor, markedSource);
  pane.operatorText.value = '';
  paintMarkupTools(editor);
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

function selectMarkAt(editor: MarkupHost, markElement: HTMLElement) {
  const markIndex = Number(markElement.dataset.markIndex);
  selectMarkIndex(editor.markup, editor.markup.marks[markIndex] ? markIndex : null);
  editor.markup.selection = null;
  paintMarkupTools(editor);
}

export function wireMarkupPane(editor: MarkupHost) {
  const pane = editor.markup;
  const onMarkActivated = (event: Event) => {
    const markElement = (event.target as Element | null)?.closest<HTMLElement>('.doc-markup-mark');
    if (!markElement) return false;
    selectMarkAt(editor, markElement);
    return true;
  };
  const trackTextSelection = () => {
    pane.selection = readSourceSelection(pane);
    if (pane.selection) selectMarkIndex(pane, null);
    paintMarkupTools(editor);
  };
  for (const surface of [pane.paper, pane.endNotes]) {
    surface.addEventListener('click', (event) => { if (!onMarkActivated(event)) trackTextSelection(); });
    surface.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (onMarkActivated(event)) event.preventDefault();
    });
  }
  pane.paper.addEventListener('keyup', trackTextSelection);
  pane.operatorText.addEventListener('input', () => paintMarkupTools(editor));
  for (const [action, button] of pane.toolButtons) button.addEventListener('click', () => addOperatorMark(editor, action));
  pane.btnAccept.addEventListener('click', () => decideSelectedMark(editor, 'accept'));
  pane.btnReject.addEventListener('click', () => decideSelectedMark(editor, 'reject'));
  pane.btnCopyPrompt.addEventListener('click', () => { void copyAgentPrompt(editor); });
}
