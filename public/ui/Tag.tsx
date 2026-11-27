import { createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { tagDescriptor } from './tag-core.ts';
import type { TagShape, TagTone } from './tag-core.ts';

type TagProps = {
  text: string;
  tone?: TagTone;
  shape?: TagShape;
};

export function Tag(props: TagProps): JSX.Element {
  const descriptor = createMemo(() => tagDescriptor({
    text: props.text,
    tone: props.tone,
    shape: props.shape,
  }));

  return (
    <span
      class={descriptor().className}
      data-tone={descriptor().tone}
      data-shape={descriptor().shape}
    >
      {descriptor().text}
    </span>
  );
}
