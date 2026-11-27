import type { Page } from 'playwright-core';
import type { mountIsland } from '../../public/ui/island.ts';
import type {
  ControlConnectionState,
  TraceSnapshot,
  UiPrefKey,
  controlConnectionSignal,
  localJsonSignal,
  localStringSignal,
  traceStateSignal,
  uiPrefSignal,
} from '../../public/ui/store-signal.ts';

const ISLAND_MODULE_URL = '/ui/island.ts';
const STORE_SIGNAL_MODULE_URL = '/ui/store-signal.ts';
const LOCAL_STORE_MODULE_URL = '/local-store.ts';
const TRACE_STORE_MODULE_URL = '/trace-store.ts';
const UI_PREFS_MODULE_URL = '/ui-prefs.ts';

export interface SolidStoreSignalCheckResult {
  ok: boolean;
  detail: string;
}

interface IslandModule {
  mountIsland: typeof mountIsland;
}

interface StoreSignalModule {
  localJsonSignal: typeof localJsonSignal;
  localStringSignal: typeof localStringSignal;
  uiPrefSignal: typeof uiPrefSignal;
  traceStateSignal: typeof traceStateSignal;
  controlConnectionSignal: typeof controlConnectionSignal;
}

interface LocalStoreModule {
  setJSON: (key: string, value: unknown) => void;
  setString: (key: string, value: string) => void;
}

interface TraceStoreModule {
  setTraceSessions: (sessions: readonly { id: string; name: string; state?: string; project?: string }[]) => void;
}

interface UiPrefsModule {
  getThemeId: () => string;
  setThemeId: (themeId: string) => void;
}

export async function verifySolidStoreSignal(page: Page): Promise<SolidStoreSignalCheckResult> {
  return page.evaluate(
    async ({
      islandUrl,
      storeSignalUrl,
      localStoreUrl,
      traceStoreUrl,
      uiPrefsUrl,
    }: {
      islandUrl: string;
      storeSignalUrl: string;
      localStoreUrl: string;
      traceStoreUrl: string;
      uiPrefsUrl: string;
    }) => {
      const islandModule = (await import(islandUrl)) as Partial<IslandModule>;
      const storeSignalModule = (await import(storeSignalUrl)) as Partial<StoreSignalModule>;
      const localStoreModule = (await import(localStoreUrl)) as Partial<LocalStoreModule>;
      const traceStoreModule = (await import(traceStoreUrl)) as Partial<TraceStoreModule>;
      const uiPrefsModule = (await import(uiPrefsUrl)) as Partial<UiPrefsModule>;

      const mountIslandFn = islandModule.mountIsland;
      const localJsonSignalFn = storeSignalModule.localJsonSignal;
      const localStringSignalFn = storeSignalModule.localStringSignal;
      const uiPrefSignalFn = storeSignalModule.uiPrefSignal;
      const traceStateSignalFn = storeSignalModule.traceStateSignal;
      const controlConnectionSignalFn = storeSignalModule.controlConnectionSignal;

      if (typeof mountIslandFn !== 'function') {
        return { ok: false, detail: 'mountIsland export is missing from /ui/island.ts' };
      }
      if (
        typeof localJsonSignalFn !== 'function'
        || typeof localStringSignalFn !== 'function'
        || typeof uiPrefSignalFn !== 'function'
        || typeof traceStateSignalFn !== 'function'
        || typeof controlConnectionSignalFn !== 'function'
      ) {
        return { ok: false, detail: 'one or more store-signal exports are missing from /ui/store-signal.ts' };
      }
      if (typeof localStoreModule.setJSON !== 'function' || typeof localStoreModule.setString !== 'function') {
        return { ok: false, detail: 'local-store setters are missing' };
      }
      if (typeof traceStoreModule.setTraceSessions !== 'function') {
        return { ok: false, detail: 'setTraceSessions is missing from /trace-store.ts' };
      }
      if (typeof uiPrefsModule.getThemeId !== 'function' || typeof uiPrefsModule.setThemeId !== 'function') {
        return { ok: false, detail: 'ui-prefs theme accessors are missing' };
      }

      const jsonKey = 'glimmervoid-store-signal-json-test';
      const stringKey = 'glimmervoid-store-signal-string-test';
      const prefKey: UiPrefKey = 'themeId';
      const previousTheme = uiPrefsModule.getThemeId();
      const statusEl = document.getElementById('connection-status');
      const labelEl = statusEl?.querySelector('.connection-label') ?? null;
      const previousConnectionState = statusEl?.dataset.state ?? '';
      const previousConnectionLabel = labelEl?.textContent ?? '';

      let readJson: () => { count: number } = () => ({ count: -1 });
      let readString: () => string = () => '';
      let readTheme: () => string = () => '';
      let readTrace: () => TraceSnapshot = () => ({
        sessionOptions: [],
        selectedSessionId: null,
        selectedTrace: null,
        pendingSessionId: null,
        traceFailureText: null,
      });
      let readConnection: () => ControlConnectionState = () => ({ state: '', label: '', isConnected: false });

      localStoreModule.setJSON(jsonKey, { count: 1 });
      localStoreModule.setString(stringKey, 'alpha');
      const host = document.createElement('div');
      document.body.append(host);

      let dispose: () => void = () => {};
      try {
        dispose = mountIslandFn(host, () => {
          readJson = localJsonSignalFn(jsonKey, { count: 0 });
          readString = localStringSignalFn(stringKey);
          readTheme = uiPrefSignalFn(prefKey);
          readTrace = traceStateSignalFn();
          readConnection = controlConnectionSignalFn();
          const marker = document.createElement('span');
          marker.dataset.storeSignalProbe = 'mounted';
          return marker;
        });

        if (readJson().count !== 1 || readString() !== 'alpha') {
          return { ok: false, detail: `unexpected initial local-store values: json=${JSON.stringify(readJson())}, str=${JSON.stringify(readString())}` };
        }
        if (readTheme() !== previousTheme) {
          return { ok: false, detail: `expected initial theme ${JSON.stringify(previousTheme)}, got ${JSON.stringify(readTheme())}` };
        }

        localStoreModule.setJSON(jsonKey, { count: 2 });
        window.dispatchEvent(new StorageEvent('storage', { key: jsonKey }));
        localStoreModule.setString(stringKey, 'beta');
        window.dispatchEvent(new StorageEvent('storage', { key: stringKey }));
        uiPrefsModule.setThemeId('solarized');
        window.dispatchEvent(new StorageEvent('storage', { key: 'glimmervoid-ui-prefs' }));
        traceStoreModule.setTraceSessions([{ id: 'trace-probe-1', name: 'Trace Probe 1', state: 'running', project: 'probe' }]);
        if (statusEl && labelEl) {
          statusEl.dataset.state = 'disconnected';
          labelEl.textContent = 'Reconnecting';
        }

        await Promise.resolve();
        await Promise.resolve();

        if (readJson().count !== 2) {
          return { ok: false, detail: `localJsonSignal did not update on storage event: ${JSON.stringify(readJson())}` };
        }
        if (readString() !== 'beta') {
          return { ok: false, detail: `localStringSignal did not update on storage event: ${JSON.stringify(readString())}` };
        }
        if (readTheme() !== 'solarized') {
          return { ok: false, detail: `uiPrefSignal did not update on storage event: ${JSON.stringify(readTheme())}` };
        }
        if (!readTrace().sessionOptions.some((option) => option.id === 'trace-probe-1')) {
          return { ok: false, detail: `traceStateSignal did not receive trace-store update: ${JSON.stringify(readTrace().sessionOptions)}` };
        }
        if (statusEl && (readConnection().state !== 'disconnected' || readConnection().isConnected !== false)) {
          return { ok: false, detail: `controlConnectionSignal did not reflect status mutation: ${JSON.stringify(readConnection())}` };
        }

        dispose();

        localStoreModule.setJSON(jsonKey, { count: 99 });
        window.dispatchEvent(new StorageEvent('storage', { key: jsonKey }));
        localStoreModule.setString(stringKey, 'after-dispose');
        window.dispatchEvent(new StorageEvent('storage', { key: stringKey }));
        uiPrefsModule.setThemeId('after-dispose-theme');
        window.dispatchEvent(new StorageEvent('storage', { key: 'glimmervoid-ui-prefs' }));
        traceStoreModule.setTraceSessions([{ id: 'trace-probe-2', name: 'Trace Probe 2', state: 'idle', project: 'probe' }]);
        if (statusEl && labelEl) {
          statusEl.dataset.state = 'connected';
          labelEl.textContent = 'Connected';
        }

        await Promise.resolve();
        await Promise.resolve();

        if (readJson().count !== 2 || readString() !== 'beta' || readTheme() !== 'solarized') {
          return {
            ok: false,
            detail: `disposed storage signals kept listening: json=${JSON.stringify(readJson())}, str=${JSON.stringify(readString())}, theme=${JSON.stringify(readTheme())}`,
          };
        }
        if (readTrace().sessionOptions.some((option) => option.id === 'trace-probe-2')) {
          return { ok: false, detail: 'disposed traceStateSignal kept listening after dispose()' };
        }
        if (statusEl && readConnection().state !== 'disconnected') {
          return { ok: false, detail: `disposed controlConnectionSignal kept listening after dispose(): ${JSON.stringify(readConnection())}` };
        }

        return { ok: true, detail: 'all store signals received live updates and stopped listening after island dispose()' };
      } finally {
        dispose();
        localStoreModule.setString(jsonKey, '');
        localStoreModule.setString(stringKey, '');
        uiPrefsModule.setThemeId(previousTheme);
        traceStoreModule.setTraceSessions([]);
        if (statusEl && labelEl) {
          statusEl.dataset.state = previousConnectionState;
          labelEl.textContent = previousConnectionLabel;
        }
        host.remove();
      }
    },
    {
      islandUrl: ISLAND_MODULE_URL,
      storeSignalUrl: STORE_SIGNAL_MODULE_URL,
      localStoreUrl: LOCAL_STORE_MODULE_URL,
      traceStoreUrl: TRACE_STORE_MODULE_URL,
      uiPrefsUrl: UI_PREFS_MODULE_URL,
    },
  );
}
