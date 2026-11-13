import './doc-editor.css';
import { DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { docsOf } from './doc-editor.ts';
import { el } from '../dom-helpers.ts';
import { applyDialogAria, createModalOverlay, openConfirmDialog } from '../session-card/modal.ts';
import { button } from '../ui/button.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { sheetWidthHandle, wireSheetWidth } from '../sheet-width.ts';
import { buildMarkupPane, disposeMarkupPane, forgetBlockPreviews, forgetDocHistory, forgetPreviewImages, isMarkupTextField, paintMarkupTools, previewEveryBlockOf, retryMissingImages, renderMarkup, stepDocEdit, wireMarkupPane } from './markup-pane.ts';
import type { MarkupHost } from './markup-pane.ts';

type DocReadOutcome = { ok: true; text: string; hash: string } | { ok: false; error: string | null };
type DocSaveOutcome = { ok: true; hash: string } | { ok: false; isConflict: boolean; error: string | null };

export interface DocSource {
  key: string;
  docs: () => readonly { path: string; name: string }[];
  isSaveable: (docPath: string) => boolean;
  conflictText: string;
  unsaveableText: string;
  read: (docPath: string) => Promise<DocReadOutcome>;
  save: (docPath: string, text: string, baseHash: string) => Promise<DocSaveOutcome>;
  readImage?: (docPath: string, imageSource: string) => Promise<Blob | null>;
}

interface OpenEditor extends MarkupHost {
  source: DocSource;
  docPath: string;
  openedDocPath: string | null;
  hasUnsavedChanges: boolean;
  needsReload: boolean;
  title: HTMLElement;
  select: HTMLSelectElement;
  status: HTMLElement;
  btnReload: HTMLButtonElement;
  autosaveTimer: ReturnType<typeof setTimeout> | null;
  pendingSave: Promise<boolean> | null;
  close: () => void;
}

const AUTOSAVE_DELAY_MS = 1000;

let openEditor: OpenEditor | null = null;

function fillDocPicker(editor: OpenEditor) {
  const docs = editor.source.docs();
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
  editor.select.disabled = editor.isBusy;
  editor.btnReload.hidden = !editor.needsReload;
  editor.btnReload.disabled = editor.isBusy || !editor.source.isSaveable(editor.docPath);
  paintMarkupTools(editor);
}

function setStatus(editor: OpenEditor, text: string, tone: 'quiet' | 'warn' = 'quiet') {
  editor.status.textContent = text;
  editor.status.dataset.tone = tone;
}

function showUnsavedChanges(editor: OpenEditor) {
  if (editor.needsReload) return;
  if (!editor.source.isSaveable(editor.docPath)) {
    setStatus(editor, editor.source.unsaveableText, 'warn');
    return;
  }
  setStatus(editor, 'Unsaved changes');
}

function cancelAutosave(editor: OpenEditor) {
  if (editor.autosaveTimer !== null) clearTimeout(editor.autosaveTimer);
  editor.autosaveTimer = null;
}

function scheduleAutosave(editor: OpenEditor) {
  cancelAutosave(editor);
  if (editor.needsReload || !editor.hasUnsavedChanges) return;
  editor.autosaveTimer = setTimeout(() => {
    editor.autosaveTimer = null;
    void saveDoc(editor);
  }, AUTOSAVE_DELAY_MS);
}

function confirmDiscard(title: string, onDiscard: () => void) {
  openConfirmDialog({ title, message: 'Your unsaved edits will be lost.', confirmLabel: 'Discard', danger: true, onConfirm: onDiscard });
}

async function saveEveryChange(editor: OpenEditor): Promise<boolean> {
  while (editor.hasUnsavedChanges) {
    cancelAutosave(editor);
    const isSaved = await saveDoc(editor);
    if (!isSaved || openEditor !== editor) return false;
  }
  return true;
}

async function whenChangesAreSaved(editor: OpenEditor, title: string, proceed: () => void) {
  const isEverythingSaved = await saveEveryChange(editor);
  if (openEditor !== editor) return;
  if (isEverythingSaved) {
    proceed();
    return;
  }
  confirmDiscard(title, proceed);
}

type DocRequestOutcome = { reply: Awaited<ReturnType<typeof sendControlRequest>> | null; failureText: string | null };

async function requestDoc(type: 'session-doc-read' | 'session-doc-save' | 'session-doc-asset-read', payload: Record<string, unknown>): Promise<DocRequestOutcome> {
  try {
    return { reply: await sendControlRequest(type, payload, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS }), failureText: null };
  } catch (reason) {
    return { reply: null, failureText: requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS) };
  }
}

async function readSessionDoc(sessionId: string, docPath: string): Promise<DocReadOutcome> {
  const { reply, failureText } = await requestDoc('session-doc-read', { id: sessionId, path: docPath });
  const response = reply?.type === 'session-doc-response' ? reply : null;
  if (!response?.ok || response.text === undefined || response.hash === undefined) return { ok: false, error: response?.error || failureText };
  return { ok: true, text: response.text, hash: response.hash };
}

async function saveSessionDoc(sessionId: string, docPath: string, text: string, baseHash: string): Promise<DocSaveOutcome> {
  const { reply, failureText } = await requestDoc('session-doc-save', { id: sessionId, path: docPath, text, baseHash });
  const response = reply?.type === 'session-doc-save-result' ? reply : null;
  if (!response?.ok || response.hash === undefined) return { ok: false, isConflict: response?.conflict === true, error: response?.error || failureText };
  return { ok: true, hash: response.hash };
}

function blobOfBase64(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

let imageReadsInFlight: Promise<unknown> = Promise.resolve();

function readSessionDocImage(sessionId: string, docPath: string, imageSource: string): Promise<Blob | null> {
  const imageRead = imageReadsInFlight.then(() => requestSessionDocImage(sessionId, docPath, imageSource));
  imageReadsInFlight = imageRead.catch(() => null);
  return imageRead;
}

async function requestSessionDocImage(sessionId: string, docPath: string, imageSource: string): Promise<Blob | null> {
  const { reply } = await requestDoc('session-doc-asset-read', { id: sessionId, path: docPath, src: imageSource });
  const response = reply?.type === 'session-doc-asset-response' ? reply : null;
  if (!response?.ok || response.base64 === undefined || response.mime === undefined) return null;
  return blobOfBase64(response.base64, response.mime);
}

function sessionDocSource(sessionId: string): DocSource {
  return {
    key: sessionId,
    docs: () => docsOf(sessionId),
    isSaveable: (docPath) => docsOf(sessionId).some((doc) => doc.path === docPath),
    conflictText: 'The agent changed this file since you opened it. Reload to see its version.',
    unsaveableText: 'This doc is no longer surfaced, so it cannot be saved.',
    read: (docPath) => readSessionDoc(sessionId, docPath),
    save: (docPath, text, baseHash) => saveSessionDoc(sessionId, docPath, text, baseHash),
    readImage: (docPath, imageSource) => readSessionDocImage(sessionId, docPath, imageSource),
  };
}

async function loadDoc(editor: OpenEditor, docPath: string) {
  cancelAutosave(editor);
  if (editor.docPath !== docPath) forgetBlockPreviews(editor);
  forgetPreviewImages(editor);
  forgetDocHistory(editor);
  editor.docPath = docPath;
  editor.isBusy = true;
  editor.baseHash = null;
  editor.textarea.readOnly = true;
  fillDocPicker(editor);
  setStatus(editor, 'Loading');
  paintControls(editor);
  const read = await editor.source.read(docPath);
  if (openEditor !== editor || editor.docPath !== docPath) return;
  editor.isBusy = false;
  editor.textarea.readOnly = false;
  editor.needsReload = !read.ok;
  if (!read.ok) {
    setStatus(editor, read.error || 'Could not open this doc', 'warn');
    paintControls(editor);
    return;
  }
  editor.textarea.value = read.text;
  editor.baseHash = read.hash;
  if (editor.openedDocPath !== docPath) previewEveryBlockOf(editor, editor.textarea.value);
  editor.openedDocPath = docPath;
  editor.hasUnsavedChanges = false;
  renderMarkup(editor);
  setStatus(editor, '');
  paintControls(editor);
}

function saveDoc(editor: OpenEditor): Promise<boolean> {
  editor.pendingSave ??= writeDoc(editor).finally(() => { editor.pendingSave = null; });
  return editor.pendingSave;
}

async function writeDoc(editor: OpenEditor): Promise<boolean> {
  if (!editor.hasUnsavedChanges) return true;
  if (editor.baseHash === null || editor.needsReload || !editor.source.isSaveable(editor.docPath)) return false;
  const savedPath = editor.docPath;
  const savedText = editor.textarea.value;
  const saved = await editor.source.save(savedPath, savedText, editor.baseHash);
  if (openEditor !== editor || editor.docPath !== savedPath) return false;
  if (!saved.ok) {
    editor.needsReload = saved.isConflict;
    setStatus(editor, saved.isConflict ? editor.source.conflictText : saved.error || 'Save failed', 'warn');
    paintControls(editor);
    return false;
  }
  editor.baseHash = saved.hash;
  editor.hasUnsavedChanges = editor.textarea.value !== savedText;
  retryMissingImages(editor);
  setStatus(editor, 'Saved');
  if (editor.hasUnsavedChanges) showUnsavedChanges(editor);
  paintControls(editor);
  scheduleAutosave(editor);
  return true;
}

function editorShortcutOf(event: KeyboardEvent): 'save' | 'undo' | 'redo' | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const isLatinLetterKey = /^[a-z]$/i.test(event.key);
  const key = isLatinLetterKey ? event.key.toLowerCase() : event.code.replace(/^Key/, '').toLowerCase();
  if (key === 's') return 'save';
  if (key === 'y' && event.ctrlKey) return 'redo';
  if (key !== 'z') return null;
  return event.shiftKey ? 'redo' : 'undo';
}

export function openDocEditor(sessionId: string) {
  openDocEditorOn(sessionDocSource(sessionId));
}

const DOC_SHEET_WIDTH_BOUNDS = { minPx: 320, maxPx: 16384 };
const DOC_SHEET_WIDTH_KEY_STEP_PX = 40;
const DOC_SHEET_MARGIN_PX = 64;

export function openDocEditorOn(source: DocSource) {
  const firstDoc = source.docs()[0];
  if (!firstDoc || openEditor) return;
  const requestClose = () => { void whenChangesAreSaved(currentEditor, 'Close this doc?', () => currentEditor.close()); };
  const modal = createModalOverlay({ dialogClass: 'doc-editor', closeOnBackdrop: false, onEscape: requestClose });
  const titleId = 'doc-editor-title';
  const title = el('h3', 'sr-only', firstDoc.name);
  title.id = titleId;
  const select = el('select', 'plan-control doc-editor-picker');
  select.setAttribute('aria-label', 'Doc');
  const status = el('span', 'doc-editor-status-text');
  status.setAttribute('role', 'status');
  const btnReload = button({ variant: 'secondary', size: 'small', label: 'Reload', action: 'reload-doc' });
  const btnClose = button({ variant: 'icon', size: 'small', label: 'Close', icon: createLineIcon(CLOSE_ICON_PATH), action: 'close-doc-editor' });
  const markup = buildMarkupPane();
  const controls = el('div', 'doc-editor-controls');
  controls.append(select, markup.btnUndo, markup.btnRedo, markup.btnPreviewAll, btnReload, btnClose);
  const footer = el('div', 'doc-editor-footer');
  footer.append(markup.hint, status);
  const textarea = el('textarea');
  const body = el('div', 'doc-editor-body');
  body.append(markup.root);
  const widthHandle = sheetWidthHandle('Doc width');
  modal.dialog.append(title, controls, body, footer, widthHandle);
  applyDialogAria(modal.dialog, titleId);
  let operatorWidthPx: number | null = null;
  wireSheetWidth({
    widthHost: modal.overlay,
    sheet: modal.dialog,
    handle: widthHandle,
    widthProperty: '--doc-sheet-width',
    bounds: DOC_SHEET_WIDTH_BOUNDS,
    keyStepPx: DOC_SHEET_WIDTH_KEY_STEP_PX,
    reservePx: DOC_SHEET_MARGIN_PX,
    getStoredWidth: () => operatorWidthPx,
    setStoredWidth: (widthPx) => { operatorWidthPx = widthPx; },
  });

  const currentEditor: OpenEditor = {
    source, docPath: firstDoc.path, openedDocPath: null, baseHash: null, hasUnsavedChanges: false, isBusy: false, needsReload: false,
    title, select, textarea, markup, status, btnReload, autosaveTimer: null, pendingSave: null,
    readImage: (imageSource) => source.readImage?.(currentEditor.docPath, imageSource) ?? Promise.resolve(null),
    close: () => {
      cancelAutosave(currentEditor);
      openEditor = null;
      disposeMarkupPane(markup);
      modal.close();
    },
  };
  openEditor = currentEditor;

  textarea.addEventListener('input', () => {
    currentEditor.hasUnsavedChanges = true;
    showUnsavedChanges(currentEditor);
    paintControls(currentEditor);
    scheduleAutosave(currentEditor);
  });
  modal.dialog.addEventListener('keydown', (event) => {
    const shortcut = editorShortcutOf(event);
    if (!shortcut || (shortcut !== 'save' && isMarkupTextField(markup, event.target))) return;
    event.preventDefault();
    if (shortcut !== 'save') {
      stepDocEdit(currentEditor, shortcut);
      return;
    }
    cancelAutosave(currentEditor);
    void saveDoc(currentEditor);
  });
  select.addEventListener('change', () => {
    const chosenPath = select.value;
    select.value = currentEditor.docPath;
    void whenChangesAreSaved(currentEditor, 'Open another doc?', () => { void loadDoc(currentEditor, chosenPath); });
  });
  wireMarkupPane(currentEditor);
  btnReload.addEventListener('click', () => {
    const reload = () => { void loadDoc(currentEditor, currentEditor.docPath); };
    if (!currentEditor.hasUnsavedChanges) {
      reload();
      return;
    }
    confirmDiscard('Reload this doc?', reload);
  });
  btnClose.addEventListener('click', requestClose);
  let pressStartTarget: EventTarget | null = null;
  modal.overlay.addEventListener('pointerdown', (event) => { pressStartTarget = event.target; });
  modal.overlay.addEventListener('click', (event) => {
    if (event.target !== modal.overlay || pressStartTarget !== modal.overlay) return;
    requestClose();
  });

  void loadDoc(currentEditor, firstDoc.path);
}

export function applyDocsToOpenEditor(sourceKey: string) {
  if (!openEditor || openEditor.source.key !== sourceKey) return;
  fillDocPicker(openEditor);
  paintControls(openEditor);
  if (openEditor.source.isSaveable(openEditor.docPath)) return;
  setStatus(openEditor, openEditor.source.unsaveableText, 'warn');
}
