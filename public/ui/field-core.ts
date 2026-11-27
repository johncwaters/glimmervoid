export type FieldLayout = 'stacked' | 'inline' | 'grid';

const LABELABLE_TAG_NAMES = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'METER', 'OUTPUT', 'PROGRESS']);

type FieldCoreOptions = {
  idPrefix: string;
  label: string;
  isTargetLabelable: boolean;
  targetId: string;
  targetHasRole: boolean;
  existingDescribedBy: string | null;
  hint?: string;
  error?: string;
  layout?: FieldLayout;
};

type FieldDescriptor = {
  readonly className: 'ui-field';
  readonly layout: FieldLayout;
  readonly labelTag: 'label' | 'span';
  readonly labelId: string;
  readonly labelFor?: string;
  readonly assignedTargetId?: string;
  readonly describedIsWrapper: boolean;
  readonly wrapperRole?: 'group';
  readonly ariaLabelledBy?: string;
  readonly hintId: string;
  readonly hintText: string;
  readonly hintHidden: boolean;
  readonly errorId: string;
  readonly errorText: string;
  readonly errorHidden: boolean;
  readonly ariaDescribedBy: string;
  readonly ariaInvalid?: 'true';
};

export function isLabelableTagName(tagName: string): boolean {
  return LABELABLE_TAG_NAMES.has(tagName.toUpperCase());
}

export function fieldMessageState(text: string): { readonly text: string; readonly hidden: boolean } {
  return { text, hidden: text === '' };
}

export function fieldDescriptor(options: FieldCoreOptions): FieldDescriptor {
  const layout = options.layout ?? 'stacked';
  const hint = fieldMessageState(options.hint ?? '');
  const error = fieldMessageState(options.error ?? '');
  const labelId = `${options.idPrefix}-label`;
  const hintId = `${options.idPrefix}-hint`;
  const errorId = `${options.idPrefix}-error`;
  const resolvedControlId = options.targetId || `${options.idPrefix}-control`;
  const describedIsWrapper = !(options.isTargetLabelable || options.targetHasRole || options.label === '');
  const ariaDescribedBy = [options.existingDescribedBy, hintId, errorId]
    .filter((id): id is string => id !== null && id !== '')
    .join(' ');

  return {
    className: 'ui-field',
    layout,
    labelTag: options.isTargetLabelable ? 'label' : 'span',
    labelId,
    ...(options.isTargetLabelable ? { labelFor: resolvedControlId } : {}),
    ...(options.isTargetLabelable && !options.targetId ? { assignedTargetId: resolvedControlId } : {}),
    describedIsWrapper,
    ...(describedIsWrapper ? { wrapperRole: 'group' as const } : {}),
    ...(!options.isTargetLabelable && options.label !== '' ? { ariaLabelledBy: labelId } : {}),
    hintId,
    hintText: hint.text,
    hintHidden: hint.hidden,
    errorId,
    errorText: error.text,
    errorHidden: error.hidden,
    ariaDescribedBy,
    ...(error.text !== '' ? { ariaInvalid: 'true' as const } : {}),
  };
}
