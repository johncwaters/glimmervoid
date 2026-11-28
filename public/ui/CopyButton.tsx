import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { writeClipboardText } from '../dom-helpers.ts';
import { Button } from './Button.tsx';
import { copyButtonDescriptor, copyStatusText } from './copy-button-core.ts';
import type { CopyButtonSize, CopyButtonVariant } from './copy-button-core.ts';

type CopyButtonProps = {
  text: () => string;
  label?: string;
  accessibleLabel?: string;
  action?: string;
  variant?: CopyButtonVariant;
  size?: CopyButtonSize;
  clearAfterMs?: number;
  hidden?: boolean;
  statusResetKey?: unknown;
};

export function CopyButton(props: CopyButtonProps): JSX.Element {
  const [statusText, setStatusText] = createSignal('');
  const descriptor = createMemo(() => copyButtonDescriptor({
    label: props.label,
    accessibleLabel: props.accessibleLabel,
    action: props.action,
    variant: props.variant,
    size: props.size,
    clearAfterMs: props.clearAfterMs,
  }));

  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let latestCopy = 0;

  const stopClearTimer = () => {
    if (clearTimer !== null) clearTimeout(clearTimer);
    clearTimer = null;
  };

  const clearStatus = () => {
    stopClearTimer();
    latestCopy += 1;
    setStatusText('');
  };

  const showStatus = (text: string) => {
    stopClearTimer();
    setStatusText(text);
    clearTimer = setTimeout(() => {
      clearTimer = null;
      setStatusText('');
    }, descriptor().clearAfterMs);
  };

  onCleanup(() => {
    stopClearTimer();
    latestCopy += 1;
  });

  const statusResetKey = createMemo(() => props.statusResetKey);

  createEffect(
    () => statusResetKey(),
    () => clearStatus(),
    { defer: true },
  );

  const handleClick = () => {
    latestCopy += 1;
    const copyId = latestCopy;
    const write = writeClipboardText(props.text());
    if (!write) {
      showStatus(copyStatusText('failed'));
      return;
    }
    write.then(
      () => { if (copyId === latestCopy) showStatus(copyStatusText('copied')); },
      () => { if (copyId === latestCopy) showStatus(copyStatusText('failed')); },
    );
  };

  return (
    <span class={descriptor().className} hidden={props.hidden}>
      <Button
        variant={descriptor().variant}
        size={descriptor().size}
        label={descriptor().label}
        action={descriptor().action}
        ariaLabel={descriptor().accessibleLabel}
        onClick={handleClick}
      />
      <span class={descriptor().statusClassName} role={descriptor().statusRole}>{statusText()}</span>
    </span>
  );
}
