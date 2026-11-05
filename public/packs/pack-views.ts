import './pack-views.css';
import type { PacksStatus } from '#shared/contracts/control/pack-messages.ts';
import { el } from '../dom-helpers.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { packsSnapshot, subscribePacks } from './packs-store.ts';

export type PackPanelView = PacksStatus['panels'][number];

const BLANK_FRAME_URL = 'about:blank';
const frameByViewId = new Map<string, HTMLIFrameElement>();
const entryUrlByViewId = new Map<string, string>();

export function packTabIcon(iconUrl: string): HTMLImageElement {
  const icon = el('img', 'pack-tab-icon');
  icon.src = iconUrl;
  icon.alt = '';
  icon.decoding = 'async';
  icon.referrerPolicy = 'no-referrer';
  return icon;
}

export function packPanelModule(panel: PackPanelView): ViewModule<HTMLElement> {
  entryUrlByViewId.set(panel.viewId, panel.entryUrl);
  return {
    mount(panelElement) {
      const frame = createSandboxedFrame({ source: { kind: 'url', url: entryUrlByViewId.get(panel.viewId) ?? BLANK_FRAME_URL }, className: 'pack-panel-frame', title: panel.label, allowsScripts: true });
      frameByViewId.set(panel.viewId, frame);
      panelElement.replaceChildren(frame);
    },
  };
}

function pointFrameAt(viewId: string, url: string): void {
  const frame = frameByViewId.get(viewId);
  if (!frame || frame.getAttribute('src') === url) return;
  frame.src = url;
}

export function showPackPanel(panel: PackPanelView): void {
  entryUrlByViewId.set(panel.viewId, panel.entryUrl);
  pointFrameAt(panel.viewId, panel.entryUrl);
}

export function retirePackPanel(viewId: string): void {
  entryUrlByViewId.delete(viewId);
  pointFrameAt(viewId, BLANK_FRAME_URL);
}

export function onPackPanelsChange(listener: (panels: readonly PackPanelView[]) => void): void {
  const notify = () => listener(packsSnapshot()?.panels ?? []);
  subscribePacks(notify);
  notify();
}
