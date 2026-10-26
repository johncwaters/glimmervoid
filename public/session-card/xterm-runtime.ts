import type { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

export interface XtermRuntime {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
  WebglAddon: typeof WebglAddon;
}

let loadedRuntime: XtermRuntime | null = null;
let pendingRuntimeLoad: Promise<XtermRuntime> | null = null;

export function readLoadedXtermRuntime(): XtermRuntime | null {
  return loadedRuntime;
}

export function loadXtermRuntime(): Promise<XtermRuntime> {
  if (loadedRuntime) return Promise.resolve(loadedRuntime);
  pendingRuntimeLoad ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-webgl')])
    .then(([xterm, fit, webgl]) => {
      loadedRuntime = { Terminal: xterm.Terminal, FitAddon: fit.FitAddon, WebglAddon: webgl.WebglAddon };
      return loadedRuntime;
    })
    .catch((error: unknown) => {
      pendingRuntimeLoad = null;
      throw error;
    });
  return pendingRuntimeLoad;
}
