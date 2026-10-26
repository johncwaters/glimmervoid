import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewLoader, shouldReloadAfterPreloadError } from '../public/view-registry-core.ts';
import type { ViewModule } from '../public/view-registry-core.ts';

function deferredModule() {
  const mountedPanels: string[] = [];
  const module: ViewModule<string> = { mount: (panel) => mountedPanels.push(panel) };
  let resolveLoad: (loaded: ViewModule<string>) => void = () => {};
  const loadStarts: number[] = [];
  const load = () => {
    loadStarts.push(loadStarts.length);
    return new Promise<ViewModule<string>>((resolve) => { resolveLoad = resolve; });
  };
  return { module, mountedPanels, loadStarts, load, finishLoad: () => resolveLoad(module) };
}

test('a lazy view loads once across prefetch and repeated shows and mounts once, only when shown', async () => {
  const loader = createViewLoader<string>();
  const lazy = deferredModule();
  const lazyView = { view: 'benchmarks', el: 'bench-panel', load: lazy.load };
  const eagerMounts: string[] = [];
  const eagerView = { view: 'focus', el: 'focus-panel', module: { mount: (panel: string) => eagerMounts.push(panel) } };

  loader.mountEagerViews([eagerView, lazyView]);
  assert.deepEqual(eagerMounts, ['focus-panel']);
  assert.deepEqual(lazy.loadStarts, []);

  const prefetched = loader.prefetch([eagerView, lazyView]);
  const firstShow = loader.show(lazyView);
  const secondShow = loader.show(lazyView);
  assert.equal(lazy.loadStarts.length, 1);
  assert.equal(loader.mountedModuleOf('benchmarks'), null);

  lazy.finishLoad();
  await prefetched;
  assert.equal(await firstShow, lazy.module);
  assert.equal(await secondShow, lazy.module);
  assert.deepEqual(lazy.mountedPanels, ['bench-panel']);
  assert.equal(loader.mountedModuleOf('benchmarks'), lazy.module);
  assert.deepEqual(eagerMounts, ['focus-panel']);
});

test('a view whose chunk failed to load is fetched again on its next show', async () => {
  const loader = createViewLoader<string>();
  const mountedPanels: string[] = [];
  const module: ViewModule<string> = { mount: (panel) => mountedPanels.push(panel) };
  let loadAttempts = 0;
  const view = { view: 'benchmarks', el: 'bench-panel', load: () => {
    loadAttempts += 1;
    return loadAttempts === 1 ? Promise.reject(new Error('chunk gone')) : Promise.resolve(module);
  } };

  await assert.rejects(loader.show(view), /chunk gone/);
  assert.equal(await loader.show(view), module);
  assert.equal(loadAttempts, 2);
  assert.deepEqual(mountedPanels, ['bench-panel']);
});

test('a stale chunk reloads the page once, not again within the reload window', () => {
  assert.equal(shouldReloadAfterPreloadError(null, 100_000, 30_000), true);
  assert.equal(shouldReloadAfterPreloadError('90000', 100_000, 30_000), false);
  assert.equal(shouldReloadAfterPreloadError('60000', 100_000, 30_000), true);
  assert.equal(shouldReloadAfterPreloadError('not a time', 100_000, 30_000), true);
});
