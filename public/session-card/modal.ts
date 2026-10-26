import { el } from '../dom-helpers.ts';

const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]';
const INERT_BY_MODAL = 'modalInert';

const openModals: { overlay: HTMLElement; dialog: HTMLElement }[] = [];

export function isModalOpen() {
  return openModals.length > 0;
}

function isTopmostOverlay(overlay: HTMLElement) {
  return openModals.at(-1)?.overlay === overlay;
}

function focusableWithin(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((candidate) => candidate.tabIndex >= 0
      && !candidate.matches(':disabled')
      && !candidate.closest('[inert]')
      && candidate.getClientRects().length > 0);
}

export function trapTabWithin(container: HTMLElement, event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const focusable = focusableWithin(container);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const isFocusInside = container.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || !isFocusInside)) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && (document.activeElement === last || !isFocusInside)) {
    event.preventDefault();
    first.focus();
  }
}

function focusFirstWithin(container: HTMLElement) {
  const firstFocusable = focusableWithin(container)[0];
  if (firstFocusable) {
    firstFocusable.focus();
    return;
  }
  container.focus();
}

function syncModalInert() {
  const topmostOverlay = openModals.at(-1)?.overlay ?? null;
  for (const child of document.body.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (topmostOverlay && child !== topmostOverlay) {
      if (child.inert) continue;
      child.inert = true;
      child.dataset[INERT_BY_MODAL] = 'true';
      continue;
    }
    if (child.dataset[INERT_BY_MODAL] !== 'true') continue;
    child.inert = false;
    delete child.dataset[INERT_BY_MODAL];
  }
}

function canReturnFocusTo(opener: Element | null): opener is HTMLElement {
  return opener instanceof HTMLElement && opener.isConnected && !opener.closest('[inert]');
}

function returnFocusAfterClose(opener: Element | null) {
  if (canReturnFocusTo(opener)) {
    opener.focus();
    return;
  }
  const topmostDialog = openModals.at(-1)?.dialog;
  if (topmostDialog) {
    focusFirstWithin(topmostDialog);
    return;
  }
  document.getElementById('app-main')?.focus();
}

export function createModalOverlay({ dialogClass = 'dialog', closeOnBackdrop = true, onEscape }: {
  dialogClass?: string;
  closeOnBackdrop?: boolean;
  onEscape?: () => void;
} = {}) {
  const opener = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = dialogClass;
  dialog.tabIndex = -1;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  const modal = { overlay, dialog };
  openModals.push(modal);
  syncModalInert();

  dialog.addEventListener('keydown', (e) => trapTabWithin(dialog, e));

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (!isTopmostOverlay(overlay)) return;
    e.preventDefault();
    if (onEscape) {
      onEscape();
      return;
    }
    close();
  }
  document.addEventListener('keydown', onKeydown);

  function keepFocusInside() {
    if (!overlay.isConnected || !isTopmostOverlay(overlay)) return;
    if (dialog.contains(document.activeElement)) return;
    focusFirstWithin(dialog);
  }

  requestAnimationFrame(keepFocusInside);
  const focusLossWatcher = new MutationObserver(() => {
    if (document.activeElement !== document.body && document.activeElement !== null) return;
    keepFocusInside();
  });
  focusLossWatcher.observe(dialog, { childList: true, subtree: true });

  function close() {
    const modalIndex = openModals.indexOf(modal);
    if (modalIndex < 0) return;
    openModals.splice(modalIndex, 1);
    focusLossWatcher.disconnect();
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    syncModalInert();
    returnFocusAfterClose(opener);
  }

  if (closeOnBackdrop) {
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return;
      close();
    });
  }

  return { overlay, dialog, close };
}

export function applyDialogAria(dialog: HTMLElement, titleId: string) {
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
}

export function buildDialogShell({ title, dialogClass = 'dialog', cancelLabel = 'Cancel' }: {
  title: string;
  dialogClass?: string;
  cancelLabel?: string;
}) {
  const { overlay, dialog, close } = createModalOverlay({ dialogClass });
  const titleId = `dialog-title-${Math.random().toString(36).slice(2)}`;

  const titleEl = el('h3', 'dialog-title', title);
  titleEl.id = titleId;
  const actions = el('div', 'dialog-actions');
  const btnCancel = el('button', 'btn-dialog btn-dialog-cancel', cancelLabel);
  actions.append(btnCancel);

  dialog.append(titleEl);
  applyDialogAria(dialog, titleId);

  return { overlay, dialog, close, titleEl, actions, btnCancel };
}

export function openConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, onConfirm }: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm?: () => void;
}) {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title });

  const msgEl = el('p', 'dialog-message', message);

  const btnConfirm = el('button', danger ? 'btn-dialog btn-dialog-confirm btn-dialog-danger' : 'btn-dialog btn-dialog-confirm', confirmLabel);

  actions.append(btnConfirm);
  dialog.append(msgEl, actions);

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', () => { close(); onConfirm?.(); });

  requestAnimationFrame(() => btnCancel.focus());
}
