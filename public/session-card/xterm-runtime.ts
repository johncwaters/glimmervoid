import type { FitAddon } from '@xterm/addon-fit';
import type { Unicode11Addon } from '@xterm/addon-unicode11';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

export interface XtermRuntime {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
  Unicode11Addon: typeof Unicode11Addon;
  WebglAddon: typeof WebglAddon;
}

let loadedRuntime: XtermRuntime | null = null;
let pendingRuntimeLoad: Promise<XtermRuntime> | null = null;

export function readLoadedXtermRuntime(): XtermRuntime | null {
  return loadedRuntime;
}

export function loadXtermRuntime(): Promise<XtermRuntime> {
  if (loadedRuntime) return Promise.resolve(loadedRuntime);
  pendingRuntimeLoad ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-unicode11'), import('@xterm/addon-webgl')])
    .then(([xterm, fit, unicode11, webgl]) => {
      loadedRuntime = { Terminal: xterm.Terminal, FitAddon: fit.FitAddon, Unicode11Addon: unicode11.Unicode11Addon, WebglAddon: webgl.WebglAddon };
      return loadedRuntime;
    })
    .catch((error: unknown) => {
      pendingRuntimeLoad = null;
      throw error;
    });
  return pendingRuntimeLoad;
}
