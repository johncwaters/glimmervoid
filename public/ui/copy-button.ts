import { el, writeClipboardText } from '../dom-helpers.ts';
import { button } from './button.ts';
import { copyButtonDescriptor, copyStatusText } from './copy-button-core.ts';
import type { CopyButtonSize, CopyButtonVariant } from './copy-button-core.ts';

type CopyButtonOptions = {
  text: () => string;
  label?: string;
  accessibleLabel?: string;
  action?: string;
  variant?: CopyButtonVariant;
  size?: CopyButtonSize;
  clearAfterMs?: number;
};

type CopyButton = {
  readonly element: HTMLSpanElement;
  readonly button: HTMLButtonElement;
  clearStatus: () => void;
};

export function copyButton(options: CopyButtonOptions): CopyButton {
  const descriptor = copyButtonDescriptor(options);
  const element = el('span', descriptor.className);
  const copy = button({
    variant: descriptor.variant,
    size: descriptor.size,
    label: descriptor.label,
    action: descriptor.action,
  });
  if (descriptor.accessibleLabel) copy.setAttribute('aria-label', descriptor.accessibleLabel);
  const status = el('span', descriptor.statusClassName);
  status.setAttribute('role', descriptor.statusRole);
  element.append(copy, status);

  const clearAfterMs = descriptor.clearAfterMs;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let latestCopy = 0;

  const stopClearTimer = () => {
    if (clearTimer !== null) clearTimeout(clearTimer);
    clearTimer = null;
  };

  const clearStatus = () => {
    stopClearTimer();
    latestCopy += 1;
    status.textContent = '';
  };

  const showStatus = (text: string) => {
    stopClearTimer();
    status.textContent = text;
    clearTimer = setTimeout(() => {
      clearTimer = null;
      status.textContent = '';
    }, clearAfterMs);
  };

  copy.addEventListener('click', () => {
    latestCopy += 1;
    const copyId = latestCopy;
    const write = writeClipboardText(options.text());
    if (!write) {
      showStatus(copyStatusText('failed'));
      return;
    }
    write.then(
      () => { if (copyId === latestCopy) showStatus(copyStatusText('copied')); },
      () => { if (copyId === latestCopy) showStatus(copyStatusText('failed')); },
    );
  });

  return { element, button: copy, clearStatus };
}
