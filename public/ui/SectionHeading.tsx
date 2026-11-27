import { Show, createMemo } from 'solid-js';
import { Dynamic } from '@solidjs/web';
import type { JSX } from '@solidjs/web';
import { sectionHeadingDescriptor } from './section-heading-core.ts';
import type { SectionHeadingCount, SectionHeadingLevel, SectionHeadingTone } from './section-heading-core.ts';

type SectionHeadingProps = {
  title: string;
  level: SectionHeadingLevel;
  count?: SectionHeadingCount;
  tone?: SectionHeadingTone;
  hint?: string | null;
  actions?: readonly HTMLElement[] | JSX.Element;
};

function hasRenderableActions(actions: unknown): boolean {
  if (actions === undefined || actions === null || typeof actions === 'boolean' || actions === '') return false;
  if (Array.isArray(actions)) return actions.some((entry) => hasRenderableActions(entry));
  return true;
}

export function SectionHeading(props: SectionHeadingProps): JSX.Element {
  const descriptor = createMemo(() => sectionHeadingDescriptor({
    level: props.level,
    count: props.count,
    tone: props.tone,
  }));

  const hasActions = createMemo(() => hasRenderableActions(props.actions));

  return (
    <div class={descriptor().className} data-tone={descriptor().tone}>
      <Dynamic component={descriptor().titleTag} class={descriptor().titleClassName}>
        {props.title}
      </Dynamic>
      <span class={descriptor().countClassName} hidden={descriptor().count.hidden}>
        {descriptor().count.text}
      </span>
      <Show when={props.hint}>
        {(hint) => <span class={descriptor().hintClassName}>{hint()}</span>}
      </Show>
      <Show when={hasActions()}>
        <div class={descriptor().actionsClassName}>{props.actions as JSX.Element}</div>
      </Show>
    </div>
  );
}
