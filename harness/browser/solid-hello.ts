import type { Page } from 'playwright-core';

const SOLID_HELLO_ISLAND_URL = '/hello-island.tsx';

export interface SolidHelloCheckResult {
  ok: boolean;
  detail: string;
}

interface HelloIslandModule {
  mountHelloIsland: (host: HTMLElement, initialGreeting: string) => {
    setGreeting: (nextGreeting: string) => void;
    dispose: () => void;
  };
}

export async function verifySolidHello(page: Page): Promise<SolidHelloCheckResult> {
  return page.evaluate(async (islandUrl: string) => {
    const imported: unknown = await import(islandUrl);
    const module = imported as Partial<HelloIslandModule>;
    if (typeof module.mountHelloIsland !== 'function') {
      return { ok: false, detail: 'mountHelloIsland export is missing from /hello-island.tsx' };
    }
    const host = document.createElement('div');
    host.dataset.solidHelloHost = 'true';
    document.body.append(host);
    try {
      const handle = module.mountHelloIsland(host, 'hello-solid-2');
      const initialText = host.querySelector('[data-solid-hello="ready"]')?.textContent ?? null;
      if (initialText !== 'hello-solid-2') {
        handle.dispose();
        return { ok: false, detail: `expected initial text "hello-solid-2", got ${JSON.stringify(initialText)}` };
      }
      handle.setGreeting('updated-solid-2');
      await Promise.resolve();
      const updatedText = host.querySelector('[data-solid-hello="ready"]')?.textContent ?? null;
      handle.dispose();
      const afterDispose = host.querySelector('[data-solid-hello="ready"]');
      if (updatedText !== 'updated-solid-2') {
        return { ok: false, detail: `expected reactive text "updated-solid-2", got ${JSON.stringify(updatedText)}` };
      }
      if (afterDispose !== null) {
        return { ok: false, detail: 'hello island node remained mounted after dispose()' };
      }
      return { ok: true, detail: 'mounted, updated reactively, and disposed cleanly' };
    } finally {
      host.remove();
    }
  }, SOLID_HELLO_ISLAND_URL);
}
