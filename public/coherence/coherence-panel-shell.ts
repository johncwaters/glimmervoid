import { el } from '../dom-helpers.ts';
import { applyDialogAria, createModalOverlay } from '../session-card/modal.ts';

export function openCoherencePanelShell({ dialogClass, titleText, titleId, body, onCloseRequest }: {
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
