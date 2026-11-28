import { Show, createEffect, createMemo, createUniqueId, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Button } from './Button.tsx';
import { dialogCloseOutcome, dialogConfirmPressOutcome, dialogDescriptor, isDialogBackdropClick } from './dialog-core.ts';
import type { DialogCloseReason, DialogCoreOptions } from './dialog-core.ts';
import { openModals, syncModalInert } from './modal-state.ts';

interface DialogProps extends DialogCoreOptions {
  open?: boolean;
  onConfirm?: () => void;
  onClose?: (reason: DialogCloseReason) => void;
  children?: JSX.Element;
}

function canRestoreFocusTo(opener: Element | null): opener is HTMLElement {
  return opener instanceof HTMLElement && opener.isConnected && !opener.closest('[inert]');
}

function restoreFocusAfterClose(opener: Element | null): void {
  if (canRestoreFocusTo(opener)) {
    opener.focus();
    return;
  }
  const topmostDialog = openModals.at(-1)?.dialog;
  if (topmostDialog instanceof HTMLElement) topmostDialog.focus();
}

export function Dialog(props: DialogProps): JSX.Element {
  const titleId = createUniqueId();
  const isOpen = createMemo(() => props.open ?? true);
  const descriptor = createMemo(() => dialogDescriptor({
    title: props.title,
    message: props.message,
    dialogClass: props.dialogClass,
    cancelLabel: props.cancelLabel,
    confirmLabel: props.confirmLabel,
    confirmAction: props.confirmAction,
    canConfirm: props.canConfirm,
    closeOnConfirm: props.closeOnConfirm,
    danger: props.danger,
    defaultAction: props.defaultAction,
    closeOnBackdrop: props.closeOnBackdrop,
    closeOnEscape: props.closeOnEscape,
  }));

  let dialogElement: HTMLDialogElement | undefined;
  let cancelButtonElement: HTMLButtonElement | undefined;
  let confirmButtonElement: HTMLButtonElement | undefined;
  let activeModalEntry: { overlay: HTMLElement; dialog: HTMLElement } | null = null;
  let openerElement: Element | null = null;
  let isSessionOpen = false;
  let isBackdropPress = false;

  const unregisterModal = () => {
    if (!activeModalEntry) return;
    const modalIndex = openModals.indexOf(activeModalEntry);
    if (modalIndex >= 0) openModals.splice(modalIndex, 1);
    activeModalEntry = null;
    syncModalInert();
  };

  const finalizeClose = (reason: DialogCloseReason, shouldNotify: boolean) => {
    if (!isSessionOpen) return;
    isSessionOpen = false;
    isBackdropPress = false;
    const savedOpener = openerElement;
    openerElement = null;
    unregisterModal();
    if (dialogElement?.open) dialogElement.close();
    restoreFocusAfterClose(savedOpener);
    if (!shouldNotify) return;
    props.onClose?.(reason);
    if (dialogCloseOutcome(reason).confirmed) props.onConfirm?.();
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (!descriptor().closeOnEscape) event.preventDefault();
  };

  const handleCancel = (event: Event) => {
    event.preventDefault();
    if (!descriptor().closeOnEscape) return;
    finalizeClose('escape', true);
  };

  const handleClose = () => {
    finalizeClose('programmatic', true);
  };

  const handlePointerDown = (event: PointerEvent) => {
    if (!dialogElement || !descriptor().closeOnBackdrop) {
      isBackdropPress = false;
      return;
    }
    isBackdropPress = event.target === dialogElement
      && isDialogBackdropClick(event, dialogElement.getBoundingClientRect());
  };

  const handleBackdropClick = (event: MouseEvent) => {
    const startedOnBackdrop = isBackdropPress;
    isBackdropPress = false;
    if (!startedOnBackdrop || !dialogElement || !descriptor().closeOnBackdrop) return;
    if (event.target !== dialogElement) return;
    if (!isDialogBackdropClick(event, dialogElement.getBoundingClientRect())) return;
    finalizeClose('backdrop', true);
  };

  const bindDialog = (element: HTMLDialogElement) => {
    dialogElement = element;
    element.addEventListener('keydown', handleKeydown);
    element.addEventListener('cancel', handleCancel);
    element.addEventListener('close', handleClose);
    element.addEventListener('pointerdown', handlePointerDown);
    element.addEventListener('click', handleBackdropClick);
  };

  onCleanup(() => {
    if (!dialogElement) return;
    dialogElement.removeEventListener('keydown', handleKeydown);
    dialogElement.removeEventListener('cancel', handleCancel);
    dialogElement.removeEventListener('close', handleClose);
    dialogElement.removeEventListener('pointerdown', handlePointerDown);
    dialogElement.removeEventListener('click', handleBackdropClick);
  });

  createEffect(
    () => isOpen(),
    (open) => {
      if (!open || !dialogElement) {
        finalizeClose('programmatic', false);
        return;
      }
      if (isSessionOpen) return;
      openerElement = document.activeElement;
      isSessionOpen = true;
      activeModalEntry = { overlay: dialogElement, dialog: dialogElement };
      openModals.push(activeModalEntry);
      syncModalInert();
      if (!dialogElement.open) dialogElement.showModal();
      const defaultButton = untrack(() => descriptor().defaultAction) === 'confirm'
        ? confirmButtonElement
        : cancelButtonElement;
      defaultButton?.focus();
      return () => {
        finalizeClose('programmatic', false);
      };
    },
  );

  return (
    <dialog
      ref={bindDialog}
      class={descriptor().className}
      aria-labelledby={titleId}
    >
      <h3 id={titleId} class="dialog-title">{descriptor().title}</h3>
      <Show when={descriptor().message}>
        {(message) => <p class="dialog-message">{message()}</p>}
      </Show>
      {props.children}
      <div class="dialog-actions">
        <Button
          ref={(element) => { cancelButtonElement = element; }}
          variant="secondary"
          label={descriptor().cancelLabel}
          onClick={() => finalizeClose('cancel', true)}
        />
        <Show when={descriptor().confirmButton}>
          {(confirmButton) => (
            <Button
              ref={(element) => { confirmButtonElement = element; }}
              variant={confirmButton().variant}
              label={confirmButton().label}
              action={confirmButton().action}
              disabled={confirmButton().disabled}
              onClick={() => {
                const pressOutcome = dialogConfirmPressOutcome(descriptor().canConfirm, descriptor().closeOnConfirm);
                pressOutcome.shouldClose
                  ? finalizeClose('confirm', true)
                  : (pressOutcome.shouldConfirm ? props.onConfirm?.() : undefined);
              }}
            />
          )}
        </Show>
      </div>
    </dialog>
  );
}
