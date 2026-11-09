import type { BrowserType } from 'playwright-core';

export type BrowserEngine = 'chromium' | 'webkit' | 'firefox';

export const BROWSER_ENGINES: readonly BrowserEngine[] = ['chromium', 'webkit', 'firefox'];

export function browserEngineNamed(name: string): BrowserEngine | null {
  return BROWSER_ENGINES.find((engine) => engine === name) ?? null;
}

export async function browserTypeOf(engine: BrowserEngine): Promise<BrowserType> {
  const playwright = await import('playwright-core');
  const browserTypeByEngine: Record<BrowserEngine, BrowserType> = { chromium: playwright.chromium, webkit: playwright.webkit, firefox: playwright.firefox };
  return browserTypeByEngine[engine];
}
