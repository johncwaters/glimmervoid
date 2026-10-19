import { nextRequestId, sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { applyDialogAria, createModalOverlay } from '../session-card/modal.ts';

function openCoherencePanelShell({ dialogClass, titleText, titleId, body, onCloseRequest }: {
  dialogClass: string;
  titleText: string;
  titleId: string;
  body: readonly HTMLElement[];
  onCloseRequest: () => void;
}) {
  const modal = createModalOverlay({ dialogClass, closeOnBackdrop: false, onEscape: onCloseRequest });
  const header = el('div', 'coherence-journal-header');
  const title = el('h3', 'dialog-title', titleText);
  title.id = titleId;
  const closeButton = el('button', 'btn-dialog btn-dialog-cancel', 'Close');
  closeButton.type = 'button';
  header.append(title, closeButton);
  modal.dialog.append(header, ...body);
  applyDialogAria(modal.dialog, title.id);
  closeButton.addEventListener('click', onCloseRequest);
  modal.overlay.addEventListener('click', (event) => {
    if (event.target === modal.overlay) onCloseRequest();
  });
  return { close: modal.close, focusClose: () => closeButton.focus() };
}

interface RequestPanel<Parts> {
  sessionId: string;
  status: HTMLElement;
  parts: Parts;
  close: () => void;
}

interface PendingRequestPanel<Parts> extends RequestPanel<Parts> {
  requestId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createRequestPanelLifecycle<Parts>({ requestPrefix, dialogClass, titleText, unavailableLabel, timeoutMs }: {
  requestPrefix: string;
  dialogClass: string;
  titleText: string;
  unavailableLabel: string;
  timeoutMs: number;
}) {
  let openPanel: PendingRequestPanel<Parts> | null = null;

  function stopWaiting(panel: PendingRequestPanel<Parts>) {
    if (panel.timer !== null) clearTimeout(panel.timer);
    panel.timer = null;
    panel.requestId = null;
  }

  function open({ sessionId, status, body, parts, paintBeforeRequest, buildRequest }: {
    sessionId: string;
    status: HTMLElement;
    body: readonly HTMLElement[];
    parts: Parts;
    paintBeforeRequest?: () => void;
    buildRequest: (requestId: string) => Record<string, unknown>;
  }) {
    openPanel?.close();
    const requestId = nextRequestId(requestPrefix);
    const shell = openCoherencePanelShell({ dialogClass, titleText, titleId: `${requestId}-title`, body, onCloseRequest: () => panel.close() });
    const panel: PendingRequestPanel<Parts> = {
      sessionId, status, parts, requestId, timer: null,
      close: () => {
        stopWaiting(panel);
        if (openPanel === panel) openPanel = null;
        shell.close();
      },
    };
    openPanel = panel;
    paintBeforeRequest?.();
    shell.focusClose();
    if (!sendControlMsg(buildRequest(requestId))) {
      panel.requestId = null;
      status.textContent = `${unavailableLabel}: not connected`;
      return;
    }
    panel.timer = setTimeout(() => {
      panel.requestId = null;
      panel.timer = null;
      status.textContent = `${unavailableLabel}: request timed out`;
    }, timeoutMs);
  }

  function settleResponse(response: { id: string; requestId?: string | null | undefined }): RequestPanel<Parts> | null {
    const panel = openPanel;
    if (!panel || panel.sessionId !== response.id || panel.requestId === null || panel.requestId !== response.requestId) return null;
    stopWaiting(panel);
    return panel;
  }

  return { open, settleResponse, currentPanel: (): RequestPanel<Parts> | null => openPanel };
}
