import { createMemo, omit } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { pressableAttributes } from './pressable-core.ts';

type PressableProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'class'> & {
  class?: string;
  text?: string;
  type?: 'button' | 'submit' | 'reset';
};

export function Pressable(props: PressableProps): JSX.Element {
  const attributes = createMemo(() => pressableAttributes(props.class ?? '', props.text));
  const rest = omit(props, 'class', 'text', 'type', 'children');

  return (
    <button
      {...rest}
      type={props.type ?? attributes().type}
      class={attributes().className}
    >
      {props.children ?? attributes().text}
    </button>
  );
}
