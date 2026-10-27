import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewLoader, } from '../public/view-registry-core.ts';
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
