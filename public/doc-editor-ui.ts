import { DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from './action-status.ts';
import { sendControlRequest } from './control-ws.ts';
import { docsOf } from './doc-editor.ts';
import { el, writeClipboardText } from './dom-helpers.ts';
import { agentPromptFor, applyOperatorMark, canApplyOperatorMark, isEndNote, marksOf, parseCriticMarkup, resolveMark } from './doc-markup-core.ts';
import type { MarkDecision, MarkSegment, MarkupSegment, OperatorMarkAction, SourceSelection } from './doc-markup-core.ts';
import { parsePlanMarkdown } from './plan/plan-markdown-core.ts';
import { renderPlanBlocks } from './plan/plan-render.ts';
import { isStreamerMode } from './streamer-mode.ts';
import { applyDialogAria, createModalOverlay, openConfirmDialog } from './session-card/modal.ts';

type EditorMode = 'edit' | 'preview' | 'markup';

interface OpenEditor {
  sessionId: string;
  docPath: string;
  baseHash: string | null;
  hasUnsavedChanges: boolean;
  isBusy: boolean;
  mode: EditorMode;
  title: HTMLElement;
  select: HTMLSelectElement;
  textarea: HTMLTextAreaElement;
  preview: HTMLElement;
  markup: MarkupPane;
  status: HTMLElement;
  btnEdit: HTMLButtonElement;
  btnPreview: HTMLButtonElement;
  btnMarkup: HTMLButtonElement;
  btnReload: HTMLButtonElement;
  btnSave: HTMLButtonElement;
  close: () => void;
}

let openEditor: OpenEditor | null = null;

function fillDocPicker(editor: OpenEditor) {
  const docs = docsOf(editor.sessionId);
  editor.select.replaceChildren(...docs.map((doc) => {
    const option = el('option', null, doc.name);
    option.value = doc.path;
    option.selected = doc.path === editor.docPath;
    return option;
  }));
  editor.select.hidden = docs.length < 2;
  editor.title.textContent = docs.find((doc) => doc.path === editor.docPath)?.name ?? editor.title.textContent;
}

function paintControls(editor: OpenEditor) {
  const isSurfaced = docsOf(editor.sessionId).some((doc) => doc.path === editor.docPath);
  editor.btnEdit.setAttribute('aria-pressed', String(editor.mode === 'edit'));
  editor.btnPreview.setAttribute('aria-pressed', String(editor.mode === 'preview'));
  editor.btnMarkup.setAttribute('aria-pressed', String(editor.mode === 'markup'));
  editor.textarea.hidden = editor.mode !== 'edit';
  editor.preview.hidden = editor.mode !== 'preview';
  editor.markup.root.hidden = editor.mode !== 'markup';
  editor.select.disabled = editor.isBusy;
  editor.btnReload.disabled = editor.isBusy || !isSurfaced;
  editor.btnSave.disabled = editor.isBusy || !isSurfaced || editor.baseHash === null || !editor.hasUnsavedChanges;
  paintMarkupTools(editor);
}

function setStatus(editor: OpenEditor, text: string, tone: 'quiet' | 'warn' = 'quiet') {
  editor.status.textContent = text;
  editor.status.dataset.tone = tone;
}

function renderPreview(editor: OpenEditor) {
  editor.preview.replaceChildren(renderPlanBlocks(parsePlanMarkdown(editor.textarea.value)));
}

interface MarkupPane {
  root: HTMLElement;
  paper: HTMLElement;
  margin: HTMLElement;
  endNotes: HTMLElement;
  operatorText: HTMLInputElement;
  toolButtons: Map<OperatorMarkAction, HTMLButtonElement>;
  btnAccept: HTMLButtonElement;
  btnReject: HTMLButtonElement;
  btnCopyPrompt: HTMLButtonElement;
  hint: HTMLElement;
  marginResizeObserver: ResizeObserver;
  selection: SourceSelection | null;
  selectedMark: MarkSegment | null;
  openMarkCount: number;
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

function buildMarkupPane(): MarkupPane {
  const operatorText = el('input', 'plan-control doc-markup-input');
  operatorText.type = 'text';
  operatorText.placeholder = 'New text or note';
  operatorText.setAttribute('aria-label', 'New text or note');
  const toolButtons = new Map(OPERATOR_MARK_LABELS.map(([action, label]) => [action, buildToolbarButton(label, 'doc-markup-tool')] as const));
  const btnAccept = buildToolbarButton('Accept', 'doc-markup-accept');
  const btnReject = buildToolbarButton('Reject', 'doc-markup-reject');
  const btnCopyPrompt = buildToolbarButton('Copy agent prompt', 'doc-markup-prompt');
  const hint = el('span', 'doc-markup-hint');
  hint.setAttribute('role', 'status');
  const tools = el('div', 'doc-markup-tools');
  const addGroup = el('div', 'doc-markup-group');
  addGroup.append(operatorText, ...toolButtons.values());
  const decideGroup = el('div', 'doc-markup-group');
  decideGroup.append(btnAccept, btnReject);
  tools.append(addGroup, decideGroup, btnCopyPrompt, hint);
  const paper = el('div', 'doc-markup-paper');
  const margin = el('div', 'doc-markup-margin');
  margin.setAttribute('aria-hidden', 'true');
  const sheet = el('div', 'doc-markup-sheet');
  sheet.append(paper, margin);
  const endNotes = el('div', 'doc-markup-end');
  const root = el('div', 'doc-markup');
  root.hidden = true;
  root.append(buildInkFilter(), tools, sheet, endNotes);
  const pane: MarkupPane = {
    root, paper, margin, endNotes, operatorText, toolButtons, btnAccept, btnReject, btnCopyPrompt, hint,
    marginResizeObserver: new ResizeObserver(() => placeMarginNotes(pane)),
    selection: null, selectedMark: null, openMarkCount: 0,
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

function buildMarkElement(mark: MarkSegment) {
  const wrapper = el('span', `doc-markup-mark doc-markup-${mark.markKind}`);
  wrapper.dataset.markStart = String(mark.start);
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
  note.dataset.markStart = String(mark.start);
  note.dataset.code = mark.note?.code ?? '';
  if (mark.note?.code === 'good') note.append(buildCheckMark());
  if (mark.note?.code && mark.note.code !== 'good') note.append(el('span', 'doc-markup-code', MARGIN_CODE_LABELS[mark.note.code] ?? mark.note.code));
  if (mark.note?.body) note.append(el('span', 'doc-markup-note-body', mark.note.body));
  return note;
}

function buildEndNote(mark: MarkSegment) {
  const note = el('div', 'doc-markup-end-note doc-markup-mark');
  note.dataset.markStart = String(mark.start);
  note.tabIndex = 0;
  note.setAttribute('role', 'button');
  note.setAttribute('aria-label', `End note: ${mark.note?.body ?? ''}`);
  note.append(el('span', 'doc-markup-code', 'End note'), el('p', 'doc-markup-note-body', mark.note?.body ?? ''));
  return note;
}

function buildSegmentElement(segment: MarkupSegment) {
  if (segment.kind === 'mark') return buildMarkElement(segment);
  const text = el('span', 'doc-markup-text', segment.text);
  text.dataset.start = String(segment.start);
  return text;
}

function renderMarkup(editor: OpenEditor) {
  const pane = editor.markup;
  const segments = parseCriticMarkup(editor.textarea.value);
  const marks = marksOf(segments);
  const endNoteMarks = marks.filter(isEndNote);
  pane.paper.replaceChildren(...segments.filter((segment) => segment.kind === 'text' || !isEndNote(segment)).map(buildSegmentElement));
  pane.margin.replaceChildren(...marks.filter((mark) => mark.note && !isEndNote(mark)).map(buildMarginNote));
  pane.endNotes.replaceChildren(...endNoteMarks.map(buildEndNote));
  pane.endNotes.hidden = endNoteMarks.length === 0;
  pane.openMarkCount = marks.length;
  pane.selectedMark = null;
  pane.selection = null;
  requestAnimationFrame(() => placeMarginNotes(pane));
  paintMarkupTools(editor);
}

function placeMarginNotes(pane: MarkupPane) {
  if (pane.root.hidden) return;
  const marginTop = pane.margin.getBoundingClientRect().top;
  let nextFreeTop = 0;
  for (const note of pane.margin.querySelectorAll<HTMLElement>('.doc-markup-note')) {
    const anchor = pane.paper.querySelector(`[data-mark-start="${note.dataset.markStart}"]`);
    const anchorTop = anchor ? anchor.getBoundingClientRect().top - marginTop : nextFreeTop;
    const top = Math.max(anchorTop, nextFreeTop);
    note.style.top = `${top}px`;
    nextFreeTop = top + note.offsetHeight + 6;
  }
  pane.margin.style.minHeight = `${nextFreeTop}px`;
}

function isMarkupLocked(editor: OpenEditor) {
  return editor.isBusy || editor.baseHash === null || editor.textarea.readOnly;
}

function paintMarkupTools(editor: OpenEditor) {
  const pane = editor.markup;
  const isLocked = isMarkupLocked(editor);
  const canAddMarks = !isLocked && !isStreamerMode();
  for (const [action, button] of pane.toolButtons) button.disabled = !canAddMarks || !canApplyOperatorMark(action, pane.selection, pane.operatorText.value);
  pane.operatorText.disabled = !canAddMarks;
  pane.btnAccept.disabled = isLocked || !pane.selectedMark;
  pane.btnReject.disabled = isLocked || !pane.selectedMark;
  pane.btnCopyPrompt.disabled = isLocked || editor.hasUnsavedChanges || pane.openMarkCount === 0;
  for (const markElement of pane.root.querySelectorAll<HTMLElement>('.doc-markup-mark, .doc-markup-note')) {
    markElement.classList.toggle('is-selected', markElement.dataset.markStart === String(pane.selectedMark?.start));
  }
  pane.hint.textContent = markupHintFor(editor);
}

function markupHintFor(editor: OpenEditor) {
  const pane = editor.markup;
  if (pane.selectedMark) return describeMark(pane.selectedMark);
  if (isStreamerMode()) return 'Adding marks is off in streamer mode.';
  if (editor.hasUnsavedChanges && pane.openMarkCount > 0) return `${pane.openMarkCount} open marks. Save before copying the agent prompt.`;
  if (pane.openMarkCount > 0) return `${pane.openMarkCount} open marks. Click one to accept or reject it.`;
  return 'Select text to strike, replace or note it; click between words to insert.';
}

function sourceOffsetAt(node: Node, offset: number): { span: HTMLElement; sourceOffset: number } | null {
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const span = node.parentElement?.closest<HTMLElement>('.doc-markup-text');
  if (!span) return null;
  return { span, sourceOffset: Number(span.dataset.start) + offset };
}

function readSourceSelection(pane: MarkupPane): SourceSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!pane.paper.contains(range.commonAncestorContainer)) return null;
  const start = sourceOffsetAt(range.startContainer, range.startOffset);
  const end = sourceOffsetAt(range.endContainer, range.endOffset);
  if (!start || !end || start.span !== end.span) return null;
  return { start: start.sourceOffset, end: end.sourceOffset };
}

function replaceDocText(editor: OpenEditor, nextText: string) {
  editor.textarea.value = nextText;
  editor.textarea.dispatchEvent(new Event('input'));
  renderMarkup(editor);
}

function decideSelectedMark(editor: OpenEditor, decision: MarkDecision) {
  const mark = editor.markup.selectedMark;
  if (!mark || isMarkupLocked(editor)) return;
  replaceDocText(editor, resolveMark(editor.textarea.value, mark, decision));
}

function addOperatorMark(editor: OpenEditor, action: OperatorMarkAction) {
  const pane = editor.markup;
  if (!pane.selection || !canApplyOperatorMark(action, pane.selection, pane.operatorText.value)) return;
  replaceDocText(editor, applyOperatorMark(editor.textarea.value, action, pane.selection, pane.operatorText.value));
  pane.operatorText.value = '';
  paintMarkupTools(editor);
}

async function copyAgentPrompt(editor: OpenEditor) {
  const pendingWrite = writeClipboardText(agentPromptFor(editor.docPath, editor.markup.openMarkCount));
  if (!pendingWrite) {
    setStatus(editor, 'This browser blocks clipboard writes here.', 'warn');
    return;
  }
  try {
    await pendingWrite;
    setStatus(editor, 'Agent prompt copied');
  } catch {
    setStatus(editor, 'Could not copy the agent prompt', 'warn');
  }
}

function selectMarkAt(editor: OpenEditor, markElement: HTMLElement) {
  const markStart = Number(markElement.dataset.markStart);
  editor.markup.selectedMark = marksOf(parseCriticMarkup(editor.textarea.value)).find((mark) => mark.start === markStart) ?? null;
  editor.markup.selection = null;
  paintMarkupTools(editor);
}

function wireMarkupPane(editor: OpenEditor) {
  const pane = editor.markup;
  const onMarkActivated = (event: Event) => {
    const markElement = (event.target as Element | null)?.closest<HTMLElement>('.doc-markup-mark');
    if (!markElement) return false;
    selectMarkAt(editor, markElement);
    return true;
  };
  const trackTextSelection = () => {
    pane.selection = readSourceSelection(pane);
    if (pane.selection) pane.selectedMark = null;
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

function confirmDiscard(title: string, onDiscard: () => void) {
  openConfirmDialog({ title, message: 'Your unsaved edits will be lost.', confirmLabel: 'Discard', danger: true, onConfirm: onDiscard });
}

function whenChangesAreSafe(editor: OpenEditor, title: string, proceed: () => void) {
  if (!editor.hasUnsavedChanges) {
    proceed();
    return;
  }
  confirmDiscard(title, proceed);
}

type DocRequestOutcome = { reply: Awaited<ReturnType<typeof sendControlRequest>> | null; failureText: string | null };

async function requestDoc(type: 'session-doc-read' | 'session-doc-save', payload: Record<string, unknown>): Promise<DocRequestOutcome> {
  try {
    return { reply: await sendControlRequest(type, payload, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS }), failureText: null };
  } catch (reason) {
    return { reply: null, failureText: requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS) };
  }
}

async function loadDoc(editor: OpenEditor, docPath: string) {
  editor.docPath = docPath;
  editor.isBusy = true;
  editor.baseHash = null;
  editor.textarea.readOnly = true;
  fillDocPicker(editor);
  setStatus(editor, 'Loading');
  paintControls(editor);
  const { reply, failureText } = await requestDoc('session-doc-read', { id: editor.sessionId, path: docPath });
  if (openEditor !== editor || editor.docPath !== docPath) return;
  editor.isBusy = false;
  editor.textarea.readOnly = false;
  const response = reply?.type === 'session-doc-response' ? reply : null;
  if (!response?.ok || response.text === undefined || response.hash === undefined) {
    setStatus(editor, response?.error || failureText || 'Could not open this doc', 'warn');
    paintControls(editor);
    return;
  }
  editor.textarea.value = response.text;
  editor.baseHash = response.hash;
  editor.hasUnsavedChanges = false;
  if (editor.mode === 'preview') renderPreview(editor);
  if (editor.mode === 'markup') renderMarkup(editor);
  setStatus(editor, '');
  paintControls(editor);
}

async function saveDoc(editor: OpenEditor) {
  if (editor.btnSave.disabled || editor.baseHash === null) return;
  editor.isBusy = true;
  setStatus(editor, 'Saving');
  paintControls(editor);
  const savedPath = editor.docPath;
  const savedText = editor.textarea.value;
  const { reply, failureText } = await requestDoc('session-doc-save', { id: editor.sessionId, path: savedPath, text: savedText, baseHash: editor.baseHash });
  if (openEditor !== editor || editor.docPath !== savedPath) return;
  editor.isBusy = false;
  const response = reply?.type === 'session-doc-save-result' ? reply : null;
  if (!response?.ok || response.hash === undefined) {
    setStatus(editor, response?.conflict ? 'The agent changed this file since you opened it. Reload to see its version.' : response?.error || failureText || 'Save failed', 'warn');
    paintControls(editor);
    return;
  }
  editor.baseHash = response.hash;
  editor.hasUnsavedChanges = editor.textarea.value !== savedText;
  setStatus(editor, editor.hasUnsavedChanges ? 'Unsaved changes' : 'Saved');
  paintControls(editor);
}

function setMode(editor: OpenEditor, mode: EditorMode) {
  editor.mode = mode;
  if (mode === 'preview') renderPreview(editor);
  if (mode === 'markup') renderMarkup(editor);
  paintControls(editor);
  if (mode === 'edit') editor.textarea.focus();
}

function buildToolbarButton(label: string, className: string) {
  const button = el('button', `plan-control ${className}`, label);
  button.type = 'button';
  return button;
}

export function openDocEditor(sessionId: string) {
  const firstDoc = docsOf(sessionId)[0];
  if (!firstDoc || openEditor) return;
  const requestClose = () => whenChangesAreSafe(currentEditor, 'Close this doc?', () => currentEditor.close());
  const modal = createModalOverlay({ dialogClass: 'doc-editor', closeOnBackdrop: false, onEscape: requestClose });
  const titleId = `doc-editor-title-${sessionId}`;
  const title = el('h3', 'doc-editor-title', firstDoc.name);
  title.id = titleId;
  const select = el('select', 'plan-control doc-editor-picker');
  select.setAttribute('aria-label', 'Doc');
  const status = el('span', 'doc-editor-status');
  status.setAttribute('role', 'status');
  const btnEdit = buildToolbarButton('Edit', 'doc-editor-mode');
  const btnPreview = buildToolbarButton('Preview', 'doc-editor-mode');
  const btnMarkup = buildToolbarButton('Markup', 'doc-editor-mode');
  const btnReload = buildToolbarButton('Reload', 'doc-editor-reload');
  const btnSave = buildToolbarButton('Save', 'doc-editor-save');
  const btnClose = buildToolbarButton('Close', 'doc-editor-close');
  const modes = el('div', 'doc-editor-modes');
  modes.append(btnEdit, btnPreview, btnMarkup);
  const actions = el('div', 'doc-editor-actions');
  actions.append(status, btnReload, btnSave, btnClose);
  const header = el('div', 'doc-editor-header');
  header.append(title, select, modes, actions);
  const textarea = el('textarea', 'plan-editor doc-editor-text');
  textarea.spellcheck = true;
  textarea.setAttribute('aria-labelledby', titleId);
  const preview = el('div', 'doc-editor-preview');
  const markup = buildMarkupPane();
  const body = el('div', 'doc-editor-body');
  body.append(textarea, preview, markup.root);
  modal.dialog.append(header, body);
  applyDialogAria(modal.dialog, titleId);

  const currentEditor: OpenEditor = {
    sessionId, docPath: firstDoc.path, baseHash: null, hasUnsavedChanges: false, isBusy: false, mode: isStreamerMode() ? 'preview' : 'edit',
    title, select, textarea, preview, markup, status, btnEdit, btnPreview, btnMarkup, btnReload, btnSave,
    close: () => {
      openEditor = null;
      markup.marginResizeObserver.disconnect();
      modal.close();
    },
  };
  openEditor = currentEditor;

  textarea.addEventListener('input', () => {
    if (currentEditor.hasUnsavedChanges) return;
    currentEditor.hasUnsavedChanges = true;
    setStatus(currentEditor, 'Unsaved changes');
    paintControls(currentEditor);
  });
  textarea.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    void saveDoc(currentEditor);
  });
  select.addEventListener('change', () => {
    const chosenPath = select.value;
    select.value = currentEditor.docPath;
    whenChangesAreSafe(currentEditor, 'Open another doc?', () => { void loadDoc(currentEditor, chosenPath); });
  });
  btnEdit.addEventListener('click', () => setMode(currentEditor, 'edit'));
  btnPreview.addEventListener('click', () => setMode(currentEditor, 'preview'));
  btnMarkup.addEventListener('click', () => setMode(currentEditor, 'markup'));
  wireMarkupPane(currentEditor);
  btnReload.addEventListener('click', () => {
    whenChangesAreSafe(currentEditor, 'Reload this doc?', () => { void loadDoc(currentEditor, currentEditor.docPath); });
  });
  btnSave.addEventListener('click', () => { void saveDoc(currentEditor); });
  btnClose.addEventListener('click', requestClose);

  void loadDoc(currentEditor, firstDoc.path);
  if (currentEditor.mode === 'edit') textarea.focus();
}

export function applyDocsToOpenEditor(sessionId: string) {
  if (!openEditor || openEditor.sessionId !== sessionId) return;
  fillDocPicker(openEditor);
  paintControls(openEditor);
  if (docsOf(sessionId).some((doc) => doc.path === openEditor?.docPath)) return;
  setStatus(openEditor, 'This doc is no longer surfaced, so it cannot be saved.', 'warn');
}

