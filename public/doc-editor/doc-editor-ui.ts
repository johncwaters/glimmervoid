import './doc-editor.css';
import { DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { docsOf } from './doc-editor.ts';
import { el } from '../dom-helpers.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import { renderPlanBlocks } from '../plan/plan-render.ts';
import { isStreamerMode } from '../streamer-mode.ts';
import { applyDialogAria, createModalOverlay, openConfirmDialog } from '../session-card/modal.ts';
import { button } from '../ui/button.ts';
import { buildMarkupPane, paintMarkupTools, renderMarkup, wireMarkupPane } from './markup-pane.ts';
import type { MarkupHost } from './markup-pane.ts';

type EditorMode = 'edit' | 'preview' | 'markup';

interface OpenEditor extends MarkupHost {
  sessionId: string;
  mode: EditorMode;
  title: HTMLElement;
  select: HTMLSelectElement;
  preview: HTMLElement;
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
  const btnEdit = button({ variant: 'quiet', size: 'small', label: 'Edit' });
  const btnPreview = button({ variant: 'quiet', size: 'small', label: 'Preview' });
  const btnMarkup = button({ variant: 'quiet', size: 'small', label: 'Markup' });
  const btnReload = button({ variant: 'secondary', label: 'Reload', action: 'reload-doc' });
  const btnSave = button({ variant: 'primary', label: 'Save', action: 'save-doc' });
  const btnClose = button({ variant: 'secondary', label: 'Close', action: 'close-doc-editor' });
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
    showStatus: (text, tone) => setStatus(currentEditor, text, tone),
    close: () => {
      openEditor = null;
      markup.marginResizeObserver.disconnect();
      markup.rowObserver?.disconnect();
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

