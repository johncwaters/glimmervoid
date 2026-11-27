import { For, Show, createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { keyChordParts, keycapDescriptor } from './keycap-core.ts';
import type { KeycapTone } from './keycap-core.ts';

type KeycapProps = {
  text: string;
  tone?: KeycapTone;
};

type KeyChordProps = {
  keys: readonly string[];
};

export function Keycap(props: KeycapProps): JSX.Element {
  const descriptor = createMemo(() => keycapDescriptor(props.text, { tone: props.tone }));
  return (
    <kbd class={descriptor().className} data-tone={descriptor().tone}>
      {descriptor().text}
    </kbd>
  );
}

export function KeyChord(props: KeyChordProps): JSX.Element {
  const parts = createMemo(() => keyChordParts(props.keys));
  return (
    <span class="ui-key-chord">
      <For each={parts()}>
        {(part) => (
          <Show
            when={part.kind === 'key'}
            fallback={<span class={part.className}>{part.text}</span>}
          >
            <Keycap text={part.text} />
          </Show>
        )}
      </For>
    </span>
  );
}
