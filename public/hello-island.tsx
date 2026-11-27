import { createSignal } from 'solid-js';
import { mountIsland } from './ui/island.ts';

interface HelloIslandHandle {
  setGreeting: (nextGreeting: string) => void;
  dispose: () => void;
}

export function mountHelloIsland(host: HTMLElement, initialGreeting: string): HelloIslandHandle {
  let setGreeting: (nextGreeting: string) => void = () => {};
  const dispose = mountIsland(host, () => {
    const [greeting, setGreetingSignal] = createSignal(initialGreeting);
    setGreeting = setGreetingSignal;
    return <span data-solid-hello="ready">{greeting()}</span>;
  });
  return { setGreeting, dispose };
}
