export type CopyButtonVariant = 'secondary' | 'quiet';
export type CopyButtonSize = 'default' | 'small';
export type CopyOutcome = 'copied' | 'failed';

export const DEFAULT_COPY_CLEAR_AFTER_MS = 1600;

type CopyButtonDescriptorInput = {
  label?: string;
  accessibleLabel?: string;
  action?: string;
  variant?: CopyButtonVariant;
  size?: CopyButtonSize;
  clearAfterMs?: number;
};

type CopyButtonDescriptor = {
  className: 'ui-copy';
  statusClassName: 'ui-copy-status';
  statusRole: 'status';
  variant: CopyButtonVariant;
  size: CopyButtonSize;
  label: string;
  accessibleLabel?: string;
  action?: string;
  clearAfterMs: number;
};

export function copyStatusText(outcome: CopyOutcome): string {
  return outcome === 'copied' ? 'Copied' : 'Copy failed';
}

export function copyButtonDescriptor(input: CopyButtonDescriptorInput = {}): CopyButtonDescriptor {
  return {
    className: 'ui-copy',
    statusClassName: 'ui-copy-status',
    statusRole: 'status',
    variant: input.variant ?? 'secondary',
    size: input.size ?? 'default',
    label: input.label ?? 'Copy',
    accessibleLabel: input.accessibleLabel,
    action: input.action,
    clearAfterMs: input.clearAfterMs ?? DEFAULT_COPY_CLEAR_AFTER_MS,
  };
}
