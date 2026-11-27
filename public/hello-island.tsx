import { createSignal } from 'solid-js';
import { render } from '@solidjs/web';

interface HelloIslandHandle {
  setGreeting: (nextGreeting: string) => void;
  dispose: () => void;
}

export function mountHelloIsland(host: HTMLElement, initialGreeting: string): HelloIslandHandle {
  const [greeting, setGreeting] = createSignal(initialGreeting);
  const dispose = render(() => <span data-solid-hello="ready">{greeting()}</span>, host);
  return { setGreeting, dispose };
}
