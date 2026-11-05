import './pack-views.css';
import type { PacksStatus } from '#shared/contracts/control/pack-messages.ts';
import { el } from '../dom-helpers.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';
import { bridgePackFrame, regrantPackFrame } from './pack-bridge-host.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { packsSnapshot, subscribePacks } from './packs-store.ts';

export type PackPanelView = PacksStatus['panels'][number];

const BLANK_FRAME_URL = 'about:blank';
const frameByViewId = new Map<string, HTMLIFrameElement>();
const panelByViewId = new Map<string, PackPanelView>();

export function packTabIcon(iconUrl: string): HTMLImageElement {
  const icon = el('img', 'pack-tab-icon');
  icon.src = iconUrl;
  icon.alt = '';
  icon.decoding = 'async';
  icon.referrerPolicy = 'no-referrer';
  return icon;
}

export function packPanelModule(panel: PackPanelView): ViewModule<HTMLElement> {
  panelByViewId.set(panel.viewId, panel);
  return {
    mount(panelElement) {
      const shownPanel = panelByViewId.get(panel.viewId);
      const frame = createSandboxedFrame({ source: { kind: 'url', url: shownPanel?.entryUrl ?? BLANK_FRAME_URL }, className: 'pack-panel-frame', title: panel.label, allowsScripts: true });
      frameByViewId.set(panel.viewId, frame);
      bridgePackFrame(panel.viewId, frame, shownPanel?.reads ?? []);
      panelElement.replaceChildren(frame);
    },
  };
}

function pointFrameAt(viewId: string, url: string, reads: PackPanelView['reads']): void {
  const frame = frameByViewId.get(viewId);
  if (!frame || frame.getAttribute('src') === url) return;
  regrantPackFrame(viewId, reads);
  frame.src = url;
}

export function showPackPanel(panel: PackPanelView): void {
  panelByViewId.set(panel.viewId, panel);
  pointFrameAt(panel.viewId, panel.entryUrl, panel.reads);
}

export function retirePackPanel(viewId: string): void {
  panelByViewId.delete(viewId);
  pointFrameAt(viewId, BLANK_FRAME_URL, []);
}

export function onPackPanelsChange(listener: (panels: readonly PackPanelView[]) => void): void {
  const notify = () => listener(packsSnapshot()?.panels ?? []);
  subscribePacks(notify);
  notify();
}
