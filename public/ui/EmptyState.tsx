import { Show, createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { emptyStateDescriptor } from './empty-state-core.ts';
import type { EmptyStateVariant } from './empty-state-core.ts';

type EmptyStateText = JSX.Element | string | Node | readonly (string | Node)[];

type EmptyStateProps = {
  text: EmptyStateText;
  title?: string;
  actions?: readonly HTMLElement[] | JSX.Element;
  variant?: EmptyStateVariant;
};

function hasRenderableActions(actions: unknown): boolean {
  if (actions === undefined || actions === null || typeof actions === 'boolean' || actions === '') return false;
  if (Array.isArray(actions)) return actions.some((entry) => hasRenderableActions(entry));
  return true;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  const hasActions = createMemo(() => hasRenderableActions(props.actions));

  const descriptor = createMemo(() => emptyStateDescriptor({
    hasTitle: Boolean(props.title),
    hasActions: hasActions(),
    variant: props.variant,
  }));

  return (
    <Show
      when={descriptor().isTextOnly}
      fallback={(
        <div class={descriptor().className} data-variant={descriptor().variant}>
          <Show when={props.title}>
            {(title) => <p class={descriptor().titleClassName}>{title()}</p>}
          </Show>
          <p class={descriptor().textClassName}>{props.text as JSX.Element}</p>
          <Show when={hasActions()}>
            <div class={descriptor().actionsClassName}>{props.actions as JSX.Element}</div>
          </Show>
        </div>
      )}
    >
      <p class={descriptor().className} data-variant={descriptor().variant}>
        {props.text as JSX.Element}
      </p>
    </Show>
  );
}
