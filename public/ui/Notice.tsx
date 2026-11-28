import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { NoticeId, NoticeTone } from '#shared/contracts/control-messages.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { Button } from './Button.tsx';
import { CopyButton } from './CopyButton.tsx';
import { noticeDescriptor, noticeShownPayload } from './notice-core.ts';
import type { NoticeReported, NoticeShownPayload } from './notice-core.ts';

type NoticeText = JSX.Element | string | readonly (string | Node)[];

type NoticeProps = {
  id: NoticeId;
  dismissLabel: string;
  isDismissIcon: boolean;
  onDismiss: () => void;
  leading?: HTMLElement | JSX.Element;
  shown?: boolean;
  text?: NoticeText;
  tone?: NoticeTone;
  actions?: readonly HTMLElement[] | JSX.Element;
  command?: string;
  meta?: string;
  reported?: NoticeReported;
  onShown?: (payload: NoticeShownPayload) => void;
};

function hasRenderableActions(actions: unknown): boolean {
  if (actions === undefined || actions === null || typeof actions === 'boolean' || actions === '') return false;
  if (Array.isArray(actions)) return actions.some((entry) => hasRenderableActions(entry));
  return true;
}

export function Notice(props: NoticeProps): JSX.Element {
  const [textElement, setTextElement] = createSignal<HTMLSpanElement | null>(null);
  const hasActions = createMemo(() => hasRenderableActions(props.actions));

  const descriptor = createMemo(() => noticeDescriptor({
    id: props.id,
    dismissLabel: props.dismissLabel,
    isDismissIcon: props.isDismissIcon,
    shown: props.shown ?? false,
    tone: props.tone,
    hasActions: hasActions(),
    command: props.command,
    meta: props.meta,
  }));

  createEffect(
    () => ({
      shown: Boolean(props.shown),
      element: textElement(),
      id: props.id,
      tone: props.tone,
      reported: props.reported,
      text: props.text,
    }),
    ({ shown, element, id, tone, reported }) => {
      if (!shown || !props.onShown) return;
      props.onShown(noticeShownPayload({
        id,
        message: element?.textContent ?? '',
        tone,
        reported,
      }));
    },
  );

  return (
    <div
      class={descriptor().className}
      id={descriptor().id}
      role={descriptor().role}
      data-tone={descriptor().tone}
      hidden={descriptor().hidden}
    >
      {props.leading as JSX.Element}
      <span ref={setTextElement} class={descriptor().textClassName}>
        {props.text as JSX.Element}
      </span>
      <span class={descriptor().actionsClassName} hidden={descriptor().actionsHidden}>
        {props.actions as JSX.Element}
      </span>
      <code class={descriptor().commandClassName} hidden={descriptor().commandHidden}>
        {descriptor().command}
      </code>
      <CopyButton
        size="small"
        action={descriptor().copyAction}
        text={() => props.command ?? ''}
        hidden={descriptor().commandHidden}
        statusResetKey={props.command ?? ''}
      />
      <span class={descriptor().metaClassName} hidden={descriptor().metaHidden}>
        {descriptor().meta}
      </span>
      <Show
        when={descriptor().dismissVariant === 'icon'}
        fallback={(
          <Button
            variant="secondary"
            size="small"
            label={descriptor().dismissLabel}
            action={descriptor().dismissAction}
            class={descriptor().dismissClassName}
            onClick={() => props.onDismiss()}
          />
        )}
      >
        <Button
          variant="icon"
          size="small"
          label={descriptor().dismissLabel}
          icon={createLineIcon(CLOSE_ICON_PATH)}
          action={descriptor().dismissAction}
          class={descriptor().dismissClassName}
          onClick={() => props.onDismiss()}
        />
      </Show>
    </div>
  );
}
