export type DialogCloseReason = 'escape' | 'backdrop' | 'cancel' | 'confirm' | 'programmatic';

type DialogAction = 'cancel' | 'confirm';

export interface DialogCoreOptions {
  title: string;
  message?: string;
  dialogClass?: string;
  cancelLabel?: string;
  confirmLabel?: string;
  confirmAction?: string;
  canConfirm?: boolean;
  closeOnConfirm?: boolean;
  danger?: boolean;
  defaultAction?: DialogAction;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
}

interface DialogConfirmButtonDescriptor {
  label: string;
  variant: 'primary' | 'danger';
  action: string;
  disabled: boolean;
}

interface DialogDescriptor {
  className: string;
  title: string;
  message: string | undefined;
  cancelLabel: string;
  confirmButton: DialogConfirmButtonDescriptor | null;
  canConfirm: boolean;
  closeOnConfirm: boolean;
  defaultAction: DialogAction;
  closeOnBackdrop: boolean;
  closeOnEscape: boolean;
}

interface DialogConfirmPressOutcome {
  shouldClose: boolean;
  shouldConfirm: boolean;
}

interface DialogCloseOutcome {
  confirmed: boolean;
  dismissed: boolean;
}

interface DialogPoint {
  clientX: number;
  clientY: number;
}

interface DialogBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const DEFAULT_DIALOG_CLASS = 'dialog';
const DEFAULT_CANCEL_LABEL = 'Cancel';
const DEFAULT_CONFIRM_LABEL = 'Confirm';
const DEFAULT_CONFIRM_ACTION = 'confirm-dialog';

function normalizeDialogClass(dialogClass: string | undefined): string {
  const trimmed = dialogClass?.trim() ?? '';
  if (!trimmed) return DEFAULT_DIALOG_CLASS;
  const classes = trimmed.split(/\s+/);
  if (classes.includes(DEFAULT_DIALOG_CLASS)) return classes.join(' ');
  return `${DEFAULT_DIALOG_CLASS} ${classes.join(' ')}`;
}

export function dialogDescriptor(options: DialogCoreOptions): DialogDescriptor {
  const canConfirm = options.canConfirm ?? true;
  const closeOnConfirm = options.closeOnConfirm ?? true;
  const confirmButton: DialogConfirmButtonDescriptor | null = options.confirmLabel === undefined
    ? null
    : {
        label: options.confirmLabel,
        variant: options.danger ? 'danger' : 'primary',
        action: options.confirmAction ?? DEFAULT_CONFIRM_ACTION,
        disabled: !canConfirm,
      };
  const defaultAction: DialogAction = options.defaultAction === 'confirm' && confirmButton !== null && canConfirm
    ? 'confirm'
    : 'cancel';

  return {
    className: normalizeDialogClass(options.dialogClass),
    title: options.title,
    message: options.message,
    cancelLabel: options.cancelLabel ?? DEFAULT_CANCEL_LABEL,
    confirmButton,
    canConfirm,
    closeOnConfirm,
    defaultAction,
    closeOnBackdrop: options.closeOnBackdrop ?? true,
    closeOnEscape: options.closeOnEscape ?? true,
  };
}

export function dialogConfirmPressOutcome(
  canConfirm: boolean,
  closeOnConfirm: boolean,
): DialogConfirmPressOutcome {
  if (!canConfirm) return { shouldClose: false, shouldConfirm: false };
  if (closeOnConfirm) return { shouldClose: true, shouldConfirm: true };
  return { shouldClose: false, shouldConfirm: true };
}

export function confirmDialogProps(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}): DialogCoreOptions {
  return {
    title: options.title,
    message: options.message,
    cancelLabel: DEFAULT_CANCEL_LABEL,
    confirmLabel: options.confirmLabel ?? DEFAULT_CONFIRM_LABEL,
    confirmAction: DEFAULT_CONFIRM_ACTION,
    danger: options.danger ?? false,
    defaultAction: 'cancel',
    closeOnBackdrop: true,
    closeOnEscape: true,
  };
}

export function dialogCloseOutcome(reason: DialogCloseReason): DialogCloseOutcome {
  if (reason === 'confirm') return { confirmed: true, dismissed: false };
  return { confirmed: false, dismissed: true };
}

export function isDialogBackdropClick(point: DialogPoint, bounds: DialogBounds): boolean {
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return false;
  return (
    point.clientX < bounds.left
    || point.clientX > bounds.right
    || point.clientY < bounds.top
    || point.clientY > bounds.bottom
  );
}
