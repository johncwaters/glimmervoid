import { BOARD_DECK_BYTES_MESSAGE, BOARD_DECK_KEY_MESSAGE, BOARD_DECK_KEYS, BoardDeckReady } from '#shared/contracts/whiteboard.ts';
import { createSandboxedFrame } from '../sandboxed-frame.ts';

const DECK_FRAME_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob: data:; font-src blob: data:";
const UNLOADED_DECK_DOCUMENT = '<!doctype html><meta charset="utf-8"><p style="font: 13px system-ui, sans-serif; color: #f4f2fb; text-align: center; margin-top: 40vh">This deck could not be loaded.</p>';
const deckKeys: ReadonlySet<string> = new Set(BOARD_DECK_KEYS);

const readyDeckFrames = new WeakSet<HTMLIFrameElement>();
let viewerSourceLoading: Promise<string> | null = null;

function loadViewerSource(): Promise<string> {
  viewerSourceLoading ??= import('virtual:deck-viewer-source').then((viewerModule) => viewerModule.default, (error: unknown) => {
    viewerSourceLoading = null;
    throw error;
  });
  return viewerSourceLoading;
}

async function loadDeckBytes(deckHref: string): Promise<ArrayBuffer> {
  const response = await fetch(deckHref);
  if (!response.ok) throw new Error(`the deck answered ${response.status}`);
  return response.arrayBuffer();
}

function deckDocumentOf(viewerSource: string): string {
  const inlineSource = viewerSource.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${DECK_FRAME_POLICY}"><script type="module">${inlineSource}</script>`;
}

function postBytesWhenReady(frame: HTMLIFrameElement, deckBytes: ArrayBuffer, listening: AbortSignal): void {
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || !BoardDeckReady.safeParse(event.data).success) return;
    readyDeckFrames.add(frame);
    const sentBytes = deckBytes.slice(0);
    frame.contentWindow?.postMessage({ type: BOARD_DECK_BYTES_MESSAGE, bytes: sentBytes }, '*', [sentBytes]);
  }, { signal: listening });
}

export function createDeckFrame(deckHref: string, title: string, listening: AbortSignal): HTMLIFrameElement {
  const frame = createSandboxedFrame({ source: { kind: 'srcdoc', html: '' }, className: 'wb-image-viewer-page wb-image-viewer-deck', title, allowsScripts: true });
  Promise.all([loadViewerSource(), loadDeckBytes(deckHref)]).then(([viewerSource, deckBytes]) => {
    if (listening.aborted) return;
    postBytesWhenReady(frame, deckBytes, listening);
    frame.srcdoc = deckDocumentOf(viewerSource);
  }, () => {
    frame.srcdoc = UNLOADED_DECK_DOCUMENT;
  });
  return frame;
}

export function forwardDeckKey(frame: HTMLIFrameElement, key: string): boolean {
  if (!readyDeckFrames.has(frame) || !deckKeys.has(key)) return false;
  frame.contentWindow?.postMessage({ type: BOARD_DECK_KEY_MESSAGE, key }, '*');
  return true;
}
