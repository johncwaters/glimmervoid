import './pack-views.css';
import type { PacksStatus } from '#shared/contracts/control/pack-messages.ts';
import { el } from '../dom-helpers.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';
import { bridgePackFrame } from './pack-bridge-host.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { packsSnapshot, subscribePacks } from './packs-store.ts';

export type PackPanelView = PacksStatus['panels'][number];

type PanelGrant = Pick<PackPanelView, 'pack' | 'reads' | 'acts'>;

const BLANK_FRAME_URL = 'about:blank';
const NO_GRANT: PanelGrant = { pack: '', reads: [], acts: [] };
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
      panelElement.replaceChildren(bridgedPanelFrame(panel.viewId, shownPanel?.entryUrl ?? BLANK_FRAME_URL, panel.label, shownPanel ?? NO_GRANT));
    },
  };
}

function bridgedPanelFrame(viewId: string, url: string, label: string, grant: PanelGrant): HTMLIFrameElement {
  const frame = createSandboxedFrame({ source: { kind: 'url', url }, className: 'pack-panel-frame', title: label, allowsScripts: true });
  frameByViewId.set(viewId, frame);
  bridgePackFrame(viewId, frame, grant);
  return frame;
}

function pointFrameAt(viewId: string, url: string, label: string, grant: PanelGrant): void {
  const frame = frameByViewId.get(viewId);
  if (!frame || frame.getAttribute('src') === url) return;
  frame.replaceWith(bridgedPanelFrame(viewId, url, label, grant));
}

export function showPackPanel(panel: PackPanelView): void {
  panelByViewId.set(panel.viewId, panel);
  pointFrameAt(panel.viewId, panel.entryUrl, panel.label, panel);
}

export function retirePackPanel(viewId: string): void {
  panelByViewId.delete(viewId);
  pointFrameAt(viewId, BLANK_FRAME_URL, frameByViewId.get(viewId)?.title ?? '', NO_GRANT);
}

export function onPackPanelsChange(listener: (panels: readonly PackPanelView[]) => void): void {
  const notify = () => listener(packsSnapshot()?.panels ?? []);
  subscribePacks(notify);
  notify();
}
