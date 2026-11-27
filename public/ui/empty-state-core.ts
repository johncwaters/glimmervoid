export type EmptyStateVariant = 'inline' | 'boxed' | 'centered';

type EmptyStateDescriptorInput = {
  hasTitle: boolean;
  hasActions: boolean;
  variant?: EmptyStateVariant;
};

type EmptyStateDescriptor = {
  rootTag: 'p' | 'div';
  className: 'ui-empty-state';
  titleClassName: 'ui-empty-state-title';
  textClassName: 'ui-empty-state-text';
  actionsClassName: 'ui-empty-state-actions';
  variant: EmptyStateVariant;
  isTextOnly: boolean;
};

export function emptyStateDescriptor(input: EmptyStateDescriptorInput): EmptyStateDescriptor {
  const isTextOnly = !input.hasTitle && !input.hasActions;
  return {
    rootTag: isTextOnly ? 'p' : 'div',
    className: 'ui-empty-state',
    titleClassName: 'ui-empty-state-title',
    textClassName: 'ui-empty-state-text',
    actionsClassName: 'ui-empty-state-actions',
    variant: input.variant ?? 'inline',
    isTextOnly,
  };
}
