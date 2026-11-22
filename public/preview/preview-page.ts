import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { el } from '../dom-helpers.ts';
import { announceSessionPageChange } from '../page-registry.ts';
import type { SessionPage } from '../page-registry.ts';
import { createPressable } from '../ui/pressable.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';
import { PREVIEW_ICON_PATH } from '../svg-dom.ts';
import { PREVIEW_ROUTE } from '#shared/contracts/session-previews.ts';

const PREVIEW_PAGE_ID = 'preview';

const previewPortBySessionId = new Map<string, number>();
let mountedRoot: HTMLElement | null = null;

function previewPathOf(sessionId: string): string {
  return `${PREVIEW_ROUTE}/${encodeURIComponent(sessionId)}/`;
}

function buildPreview(sessionId: string, port: number): HTMLElement {
  const root = el('div', 'session-preview');
  const bar = el('div', 'session-preview-bar');
  const address = el('span', 'session-preview-address', `localhost:${port}`);
  const frame = createSandboxedFrame({ source: { kind: 'url', url: previewPathOf(sessionId) }, className: 'session-preview-frame', title: `Preview of localhost:${port}`, allowsScripts: true });
  const reloadButton = createPressable('session-preview-reload', 'Reload');
  reloadButton.addEventListener('click', () => { frame.src = previewPathOf(sessionId); });
  const openLink = el('a', 'session-preview-open', 'Open in a tab');
  openLink.setAttribute('href', previewPathOf(sessionId));
  openLink.setAttribute('target', '_blank');
  openLink.setAttribute('rel', 'noopener noreferrer');
  bar.append(address, reloadButton, openLink);
  root.append(bar, frame);
  return root;
}

function announcePreview(sessionId: string) {
  announceSessionPageChange(PREVIEW_PAGE_ID, sessionId);
}

export function applySessionPreviewChanged(message: ServerMessageOf<'session-preview-changed'>) {
  if (message.port === null) previewPortBySessionId.delete(message.id);
  if (message.port !== null) previewPortBySessionId.set(message.id, message.port);
  announcePreview(message.id);
}

export function applySessionPreviewsSnapshot(message: ServerMessageOf<'session-previews-snapshot'>) {
  const announcedIds = new Set([...previewPortBySessionId.keys(), ...Object.keys(message.ports)]);
  previewPortBySessionId.clear();
  for (const [sessionId, port] of Object.entries(message.ports)) previewPortBySessionId.set(sessionId, port);
  for (const sessionId of announcedIds) announcePreview(sessionId);
}

function unmountPreview() {
  mountedRoot?.remove();
  mountedRoot = null;
}

export const previewPage: SessionPage = {
  id: PREVIEW_PAGE_ID,
  label: 'Preview',
  iconPath: PREVIEW_ICON_PATH,
  isAvailableFor: (sessionId) => previewPortBySessionId.has(sessionId),
  hasUnreadFor: () => false,
  mount(host, sessionId) {
    unmountPreview();
    const port = previewPortBySessionId.get(sessionId);
    if (port === undefined) return;
    mountedRoot = buildPreview(sessionId, port);
    host.append(mountedRoot);
  },
  unmount: unmountPreview,
  canStepBack: () => false,
  stepBack: () => {},
};
