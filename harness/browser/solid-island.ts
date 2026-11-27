import type { Page } from 'playwright-core';
import type { mountIsland } from '../../public/ui/island.ts';
import type { localStringSignal } from '../../public/ui/store-signal.ts';

const ISLAND_MODULE_URL = '/ui/island.ts';
const STORE_SIGNAL_MODULE_URL = '/ui/store-signal.ts';

export interface SolidIslandCheckResult {
  ok: boolean;
  detail: string;
}

interface IslandModule {
  mountIsland: typeof mountIsland;
}

interface StoreSignalModule {
  localStringSignal: typeof localStringSignal;
}

export async function verifySolidIsland(page: Page): Promise<SolidIslandCheckResult> {
  return page.evaluate(
    async ({ islandUrl, storeSignalUrl }: { islandUrl: string; storeSignalUrl: string }) => {
      const islandModule = (await import(islandUrl)) as Partial<IslandModule>;
      const storeSignalModule = (await import(storeSignalUrl)) as Partial<StoreSignalModule>;
      const mountIslandFn = islandModule.mountIsland;
      const localStringSignalFn = storeSignalModule.localStringSignal;
      if (typeof mountIslandFn !== 'function') {
        return { ok: false, detail: 'mountIsland export is missing from /ui/island.ts' };
      }
      if (typeof localStringSignalFn !== 'function') {
        return { ok: false, detail: 'localStringSignal export is missing from /ui/store-signal.ts' };
      }

      const counts = { storageListeners: 0, observers: 0 };
      const readCounts = () => ({ storageListeners: counts.storageListeners, observers: counts.observers });
      const originalAdd = window.addEventListener.bind(window);
      const originalRemove = window.removeEventListener.bind(window);
      window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
        if (type === 'storage') counts.storageListeners += 1;
        return originalAdd(type, listener, options);
      }) as typeof window.addEventListener;
      window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
        if (type === 'storage') counts.storageListeners -= 1;
        return originalRemove(type, listener, options);
      }) as typeof window.removeEventListener;

      const originalObserve = MutationObserver.prototype.observe;
      const originalDisconnect = MutationObserver.prototype.disconnect;
      MutationObserver.prototype.observe = function patchedObserve(target: Node, options?: MutationObserverInit) {
        counts.observers += 1;
        return originalObserve.call(this, target, options);
      };
      MutationObserver.prototype.disconnect = function patchedDisconnect() {
        counts.observers -= 1;
        return originalDisconnect.call(this);
      };

      const manualHost = document.createElement('div');
      const autoHost = document.createElement('div');
      document.body.append(manualHost, autoHost);

      try {
        const disposeManual = mountIslandFn(manualHost, () => {
          localStringSignalFn('glimmervoid-island-manual-probe');
          const marker = document.createElement('span');
          marker.dataset.islandProbe = 'manual';
          marker.textContent = 'manual-mounted';
          return marker;
        });

        if (manualHost.querySelector('[data-island-probe="manual"]')?.textContent !== 'manual-mounted') {
          disposeManual();
          return { ok: false, detail: 'manual island did not render into host' };
        }
        const mountedCounts = readCounts();
        if (mountedCounts.storageListeners !== 1) {
          disposeManual();
          return {
            ok: false,
            detail: `expected 1 storage listener while mounted, got listeners=${mountedCounts.storageListeners}`,
          };
        }

        disposeManual();
        if (manualHost.querySelector('[data-island-probe="manual"]') !== null) {
          return { ok: false, detail: 'manual island node remained after dispose()' };
        }
        const afterManualCounts = readCounts();
        if (afterManualCounts.storageListeners !== 0 || afterManualCounts.observers !== 0) {
          return {
            ok: false,
            detail: `expected 0 listener delta and 0 observer delta after manual dispose(), got listeners=${afterManualCounts.storageListeners}, observers=${afterManualCounts.observers}`,
          };
        }

        mountIslandFn(autoHost, () => {
          localStringSignalFn('glimmervoid-island-auto-probe');
          const marker = document.createElement('span');
          marker.dataset.islandProbe = 'auto';
          marker.textContent = 'auto-mounted';
          return marker;
        });

        if (autoHost.querySelector('[data-island-probe="auto"]')?.textContent !== 'auto-mounted') {
          return { ok: false, detail: 'auto-dispose island did not render into host' };
        }

        autoHost.remove();
        await Promise.resolve();
        await Promise.resolve();

        if (autoHost.querySelector('[data-island-probe="auto"]') !== null) {
          return { ok: false, detail: 'island node remained after host left the DOM' };
        }
        const afterAutoCounts = readCounts();
        if (afterAutoCounts.storageListeners !== 0 || afterAutoCounts.observers !== 0) {
          return {
            ok: false,
            detail: `expected 0 listener delta and 0 observer delta after host removal, got listeners=${afterAutoCounts.storageListeners}, observers=${afterAutoCounts.observers}`,
          };
        }

        const shadowContainer = document.createElement('div');
        const shadowRoot = shadowContainer.attachShadow({ mode: 'open' });
        const shadowHost = document.createElement('div');
        shadowRoot.append(shadowHost);
        document.body.append(shadowContainer);
        try {
          mountIslandFn(shadowHost, () => {
            localStringSignalFn('glimmervoid-island-shadow-probe');
            const marker = document.createElement('span');
            marker.dataset.islandProbe = 'shadow';
            marker.textContent = 'shadow-mounted';
            return marker;
          });
          shadowHost.remove();
          await Promise.resolve();
          await Promise.resolve();
          if (shadowHost.querySelector('[data-island-probe="shadow"]') !== null) {
            return { ok: false, detail: 'shadow-root island node remained after host removal' };
          }
          const afterShadowCounts = readCounts();
          if (afterShadowCounts.storageListeners !== 0 || afterShadowCounts.observers !== 0) {
            return {
              ok: false,
              detail: `expected 0 listener delta and 0 observer delta after shadow removal, got listeners=${afterShadowCounts.storageListeners}, observers=${afterShadowCounts.observers}`,
            };
          }
        } finally {
          shadowContainer.remove();
        }

        return { ok: true, detail: 'manual dispose and host-removal auto-dispose left zero nodes and zero listeners' };
      } finally {
        window.addEventListener = originalAdd;
        window.removeEventListener = originalRemove;
        MutationObserver.prototype.observe = originalObserve;
        MutationObserver.prototype.disconnect = originalDisconnect;
        manualHost.remove();
        autoHost.remove();
      }
    },
    { islandUrl: ISLAND_MODULE_URL, storeSignalUrl: STORE_SIGNAL_MODULE_URL },
  );
}
