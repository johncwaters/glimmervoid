import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { SessionDoc } from '#shared/contracts/session.ts';
import { describeFailure } from './client-error-core.ts';
import { reportToServerLog } from './control-ws.ts';
import { findSessionUi } from './session-card/card-registry.ts';

type DocEditorUi = typeof import('./doc-editor-ui.ts');

const docsBySessionId = new Map<string, SessionDoc[]>();

export function docsOf(sessionId: string): SessionDoc[] {
  return docsBySessionId.get(sessionId) ?? [];
}

export function hasSessionDocs(sessionId: string): boolean {
  return docsOf(sessionId).length > 0;
}

function paintDocsButton(sessionId: string) {
  findSessionUi(sessionId)?.btnDocs.classList.toggle('visible', hasSessionDocs(sessionId));
}

let loadedEditorUi: DocEditorUi | null = null;
let pendingEditorUiLoad: Promise<DocEditorUi | null> | null = null;

function loadEditorUi(): Promise<DocEditorUi | null> {
  pendingEditorUiLoad ??= import('./doc-editor-ui.ts').then(
    (editorUi) => {
      loadedEditorUi = editorUi;
      return editorUi;
    },
    (error: unknown) => {
      pendingEditorUiLoad = null;
      reportToServerLog('doc-editor', `doc editor failed to load: ${describeFailure(error)}`);
      return null;
    },
  );
  return pendingEditorUiLoad;
}

export function openDocEditor(sessionId: string) {
  void loadEditorUi().then((editorUi) => editorUi?.openDocEditor(sessionId));
}

function applyDocsToOpenEditor(sessionId: string) {
  loadedEditorUi?.applyDocsToOpenEditor(sessionId);
}

export function applySessionDocsChanged(message: ServerMessageOf<'session-docs-changed'>) {
  docsBySessionId.set(message.id, message.docs);
  if (message.docs.length === 0) docsBySessionId.delete(message.id);
  paintDocsButton(message.id);
  applyDocsToOpenEditor(message.id);
}

export function applySessionDocsSnapshot(message: ServerMessageOf<'session-docs-snapshot'>) {
  const previousSessionIds = [...docsBySessionId.keys()];
  docsBySessionId.clear();
  for (const [sessionId, docs] of Object.entries(message.sessions)) docsBySessionId.set(sessionId, docs);
  for (const sessionId of new Set([...previousSessionIds, ...docsBySessionId.keys()])) {
    paintDocsButton(sessionId);
    applyDocsToOpenEditor(sessionId);
  }
}
