import { el, writeClipboardText } from '../dom-helpers.ts';
import { button } from './button.ts';

type CopyButtonOptions = {
  text: () => string;
  label?: string;
  accessibleLabel?: string;
  action?: string;
  variant?: 'secondary' | 'quiet';
  size?: 'default' | 'small';
  clearAfterMs?: number;
};

type CopyButton = {
  readonly element: HTMLSpanElement;
  readonly button: HTMLButtonElement;
  clearStatus: () => void;
};

const COPIED_TEXT = 'Copied';
const COPY_FAILED_TEXT = 'Copy failed';
const DEFAULT_CLEAR_AFTER_MS = 1600;

export function copyButton(options: CopyButtonOptions): CopyButton {
  const element = el('span', 'ui-copy');
  const copy = button({
    variant: options.variant ?? 'secondary',
    size: options.size ?? 'default',
    label: options.label ?? 'Copy',
    action: options.action,
  });
  if (options.accessibleLabel) copy.setAttribute('aria-label', options.accessibleLabel);
  const status = el('span', 'ui-copy-status');
  status.setAttribute('role', 'status');
  element.append(copy, status);

  const clearAfterMs = options.clearAfterMs ?? DEFAULT_CLEAR_AFTER_MS;
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
      showStatus(COPY_FAILED_TEXT);
      return;
    }
    write.then(
      () => { if (copyId === latestCopy) showStatus(COPIED_TEXT); },
      () => { if (copyId === latestCopy) showStatus(COPY_FAILED_TEXT); },
    );
  });

  return { element, button: copy, clearStatus };
}
