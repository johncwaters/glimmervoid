import { createMemo, createSignal } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { detailsBlockDescriptor, disclosureDescriptor } from './disclosure-core.ts';
import type { DisclosureMarker } from './disclosure-core.ts';

type DisclosureContent = JSX.Element | Node | string | readonly (Node | string)[];

type DisclosureProps = {
  summary: DisclosureContent;
  body?: DisclosureContent | (() => DisclosureContent);
  open?: boolean;
  marker?: DisclosureMarker;
  onToggle?: (open: boolean) => void;
  children?: JSX.Element;
};

type DetailsBlockProps = {
  text: string;
};

export function Disclosure(props: DisclosureProps): JSX.Element {
  const [hasOpened, setHasOpened] = createSignal(false);
  const descriptor = createMemo(() => disclosureDescriptor({
    marker: props.marker,
    open: props.open,
  }));

  let wasBodyActivated = false;
  const isBodyActivated = createMemo(() => {
    if (wasBodyActivated) return true;
    if (!hasOpened() && !descriptor().open) return false;
    wasBodyActivated = true;
    return true;
  });

  const resolvedBody = createMemo<JSX.Element>(() => {
    const bodyContent = props.body;
    if (bodyContent === undefined) return props.children;
    if (typeof bodyContent !== 'function') return bodyContent as JSX.Element;
    if (!isBodyActivated()) return undefined;
    return bodyContent() as JSX.Element;
  });

  return (
    <details
      class={descriptor().className}
      data-marker={descriptor().marker}
      open={descriptor().open}
      onToggle={(event) => {
        const isNowOpen = event.currentTarget.open;
        if (isNowOpen && !hasOpened()) setHasOpened(true);
        props.onToggle?.(isNowOpen);
      }}
    >
      <summary class={descriptor().summaryClassName}>
        <span class={descriptor().markerClassName} aria-hidden="true" />
        {props.summary as JSX.Element}
      </summary>
      <div class={descriptor().bodyClassName}>{resolvedBody()}</div>
    </details>
  );
}

export function DetailsBlock(props: DetailsBlockProps): JSX.Element {
  const descriptor = createMemo(() => detailsBlockDescriptor(props.text));
  return (
    <Disclosure
      summary={descriptor().summary}
      body={<pre class={descriptor().bodyClassName}>{descriptor().text}</pre>}
    />
  );
}
