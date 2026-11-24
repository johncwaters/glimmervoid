
type PopupPhase = 'hidden' | 'pending' | 'shown';

export type PopupState = { phase: PopupPhase; isPointerOnLink: boolean; isPointerOnPopup: boolean; isPinned: boolean };

export type PopupEvent = 'enter-link' | 'leave-link' | 'enter-popup' | 'leave-popup' | 'escape' | 'pin' | 'show-timer' | 'hide-timer' | 'dwell-timer';

export type PopupEffect = 'schedule-show' | 'cancel-show' | 'schedule-hide' | 'cancel-hide' | 'schedule-dwell' | 'cancel-dwell' | 'fetch-preview' | 'render' | 'remove';

type PopupTransition = { state: PopupState; effects: PopupEffect[] };

type PopupPlacement = { side: 'below' | 'above'; leftPx: number; topPx: number };

export type AnchorBox = { topPx: number; bottomPx: number; leftPx: number };

type PopupPlacementInput = {
  anchor: AnchorBox;
  boundsHeightPx: number;
  boundsWidthPx: number;
  popupHeightPx: number;
  popupWidthPx: number;
};

type DisplayUrl = { scheme: string; host: string; rest: string };

type HostMismatch = { textHost: string; targetHost: string };

export const HIDDEN_POPUP: PopupState = { phase: 'hidden', isPointerOnLink: false, isPointerOnPopup: false, isPinned: false };

const WRAPPING_PUNCTUATION = /^[("'<[{]+|[)"'>\]}.,;:!?]+$/g;
const FILE_EXTENSION_TOP_LABELS = new Set(['md', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'rs', 'go', 'sh', 'txt', 'yml', 'yaml', 'toml', 'lock', 'html', 'css', 'rb', 'java', 'kt', 'swift', 'cs', 'php', 'sql', 'log', 'env', 'cfg', 'ini', 'xml', 'svg', 'png', 'jpg', 'gif', 'pdf', 'zip']);
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HAS_WHITESPACE = /\s/;
const ALPHABETIC_TOP_LABEL = /\.[a-z]{2,63}$/i;
const LEADING_WWW = /^www\./;

function isPointerAway(state: PopupState) {
  return !state.isPinned && !state.isPointerOnLink && !state.isPointerOnPopup;
}

function enterLink(state: PopupState): PopupTransition {
  const pointed = { ...state, isPointerOnLink: true };
  if (state.isPinned) return { state: pointed, effects: [] };
  if (state.phase === 'shown') return { state: pointed, effects: ['cancel-hide', 'schedule-dwell', 'render'] };
  if (state.phase === 'pending') return { state: pointed, effects: ['schedule-dwell'] };
  return { state: { ...pointed, phase: 'pending' }, effects: ['schedule-show', 'schedule-dwell'] };
}

function leaveLink(state: PopupState): PopupTransition {
  const unpointed = { ...state, isPointerOnLink: false };
  if (state.phase === 'shown' && isPointerAway(unpointed)) return { state: unpointed, effects: ['schedule-hide'] };
  return { state: unpointed, effects: [] };
}

function leavePopup(state: PopupState): PopupTransition {
  const unpointed = { ...state, isPointerOnPopup: false };
  if (state.phase === 'shown' && isPointerAway(unpointed)) return { state: unpointed, effects: ['schedule-hide'] };
  return { state: unpointed, effects: [] };
}

export function nextPopupState(state: PopupState, event: PopupEvent): PopupTransition {
  switch (event) {
    case 'enter-link':
      return enterLink(state);
    case 'leave-link':
      return leaveLink(state);
    case 'enter-popup':
      return { state: { ...state, isPointerOnPopup: true }, effects: state.phase === 'shown' ? ['cancel-hide'] : [] };
    case 'leave-popup':
      return leavePopup(state);
    case 'escape':
      if (state.phase === 'hidden') return { state, effects: [] };
      return { state: { ...state, phase: 'hidden', isPointerOnPopup: false, isPinned: false }, effects: ['cancel-show', 'cancel-hide', 'cancel-dwell', 'remove'] };
    case 'pin':
      return { state: { ...state, phase: 'shown', isPinned: true }, effects: ['cancel-show', 'cancel-hide', 'render'] };
    case 'show-timer':
      if (state.phase !== 'pending') return { state, effects: [] };
      if (!state.isPointerOnLink) return { state: { ...state, phase: 'hidden' }, effects: [] };
      return { state: { ...state, phase: 'shown' }, effects: ['render'] };
    case 'hide-timer':
      if (state.phase !== 'shown' || !isPointerAway(state)) return { state, effects: [] };
      return { state: { ...state, phase: 'hidden' }, effects: ['remove'] };
    case 'dwell-timer':
      if (state.phase !== 'shown' || !state.isPointerOnLink) return { state, effects: [] };
      return { state, effects: ['fetch-preview'] };
  }
}

export function decidePopupPlacement(input: PopupPlacementInput): PopupPlacement {
  const { anchor, boundsHeightPx, boundsWidthPx, popupHeightPx, popupWidthPx } = input;
  const belowTopPx = anchor.bottomPx;
  const aboveTopPx = anchor.topPx - popupHeightPx;
  const roomBelowPx = boundsHeightPx - belowTopPx;
  const roomAbovePx = anchor.topPx;
  const maxLeftPx = Math.max(0, boundsWidthPx - popupWidthPx);
  const leftPx = Math.min(Math.max(0, anchor.leftPx), maxLeftPx);
  const fitsBelow = roomBelowPx >= popupHeightPx;
  const fitsAbove = roomAbovePx >= popupHeightPx;
  const isAbove = !fitsBelow && (fitsAbove || roomAbovePx > roomBelowPx);
  if (isAbove) return { side: 'above', leftPx, topPx: Math.max(0, aboveTopPx) };
  return { side: 'below', leftPx, topPx: belowTopPx };
}

export function roomBesideAnchorPx(anchor: AnchorBox, boundsHeightPx: number): number {
  return Math.max(anchor.topPx, boundsHeightPx - anchor.bottomPx);
}

function parseHttpUrl(text: string): URL | null {
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function splitUrlForDisplay(url: string): DisplayUrl | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  const credentials = parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : '';
  const scheme = `${parsed.protocol}//${credentials}`;
  const rest = `${parsed.pathname === '/' && !parsed.search && !parsed.hash ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
  return { scheme, host: parsed.host, rest };
}

function hostNamedByText(linkText: string): string | null {
  const trimmed = linkText.trim().replace(WRAPPING_PUNCTUATION, '');
  if (trimmed.length === 0 || HAS_WHITESPACE.test(trimmed)) return null;
  const parsed = parseHttpUrl(HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (!parsed) return null;
  const hostname = parsed.hostname.replace(/\.$/, '');
  if (!ALPHABETIC_TOP_LABEL.test(hostname)) return null;
  if (!HAS_SCHEME.test(trimmed) && FILE_EXTENSION_TOP_LABELS.has(hostname.slice(hostname.lastIndexOf('.') + 1).toLowerCase())) return null;
  return hostname;
}

function isSameSite(firstHost: string, secondHost: string) {
  const first = firstHost.replace(LEADING_WWW, '');
  const second = secondHost.replace(LEADING_WWW, '');
  return first === second || first.endsWith(`.${second}`) || second.endsWith(`.${first}`);
}

export function decideHostMismatch(linkText: string, targetUrl: string): HostMismatch | null {
  const target = parseHttpUrl(targetUrl);
  if (!target) return null;
  const textHost = hostNamedByText(linkText);
  if (!textHost) return null;
  const targetHost = target.hostname.replace(/\.$/, '');
  if (isSameSite(textHost, targetHost)) return null;
  return { textHost, targetHost };
}
