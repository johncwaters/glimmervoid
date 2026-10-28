import { writeAttributeIfChanged, writeHiddenIfChanged, writeTextIfChanged } from './status-paint.ts';
import type { StatusIcon } from '#shared/state-icons.ts';
import { STATE_ICONS } from '#shared/state-icons.ts';
import { STATES } from '#shared/states.ts';
import { el, query } from './dom-helpers.ts';
import type { AttentionCounts, AttentionKind, AttentionTile } from './focus-view/attention-core.ts';
import { ATTENTION_TILE_SIZES_PX, attentionSummaryText, fitAttentionTiles } from './focus-view/attention-core.ts';
import { paintStatusIcon } from './status-icon.ts';

const NO_ATTENTION: AttentionCounts = { waitingCount: 0, finishedCount: 0, failedCount: 0 };

const ICON_BY_KIND: Readonly<Record<AttentionKind, StatusIcon>> = {
  failed: STATE_ICONS[STATES.FAILED],
  waiting: STATE_ICONS[STATES.WAITING],
  finished: STATE_ICONS[STATES.COMPLETE],
};

const NEED_WORDS_BY_KIND: Readonly<Record<AttentionKind, string>> = {
  failed: 'failed',
  waiting: 'needs you',
  finished: 'finished',
};

const ALL_CLEAR_LINES = [
  'NI.',
  'THIS QUEUE IS DECEASED',
  'AND NOW, NOTHING AT ALL',
  'TOUCH GRASS, BRIEFLY',
  'GO STRETCH',
  'THE AGENTS ARE COPING',
  'MORALE IS ADEQUATE',
  'REQUIESCAT',
  'STANDARDS ARE BEING MET',
  'THE AGENTS WANT SPACE',
  'NO CAUSE FOR ALARM',
  'KINDLY GO AWAY',
  'THEY COPE WITHOUT YOU',
  'PRESS HARDER, PERHAPS',
  'OH, WELL DONE',
  'THAT DID NOTHING. AGAIN.',
  'WELL. YOU TRIED.',
  'SUBJECT PRESSED BUTTON',
  'THE BUTTON WORKS. YOU?',
  'WE HAVE NO PROBLEMS',
  'THE LAWYERS SAY RELAX',
  'BRING A TOWEL',
];

const ALL_CLEAR_LINE_HOLD_MS = 2500;
const EASE_OUT_EXPO = 'cubic-bezier(0.16, 1, 0.3, 1)';
const EASE_IN_OUT_FLIGHT = 'cubic-bezier(0.5, 0, 0.2, 1)';
const PRESS_MS = 260;
const TILE_ENTER_MS = 200;
const TILE_LEAVE_MS = 200;
const TILE_SLIDE_MS = 300;
const TILE_SLIDE_STAGGER_MS = 28;
const TILE_PROMOTE_MS = 360;
const TILE_FLY_MS = 420;
const TILE_FADE_MS = 200;
const KEYCAP_TRAVEL_PX = 3;

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

interface AttentionBannerHooks {
  onJump: () => void;
  rowFor: (sessionId: string) => HTMLElement | null | undefined;
}

interface BannerMotion {
  hooks: AttentionBannerHooks;
  tiles: readonly AttentionTile[];
  tileById: Map<string, HTMLSpanElement>;
  headId: string | null;
  flyingIds: Set<string>;
  tetheredId: string | null;
  tetheredRow: HTMLElement | null;
  lastAllClearLine: string | null;
  allClearLineTimer: number | null;
  pressAnimations: Animation[];
}

const motionByBanner = new WeakMap<HTMLElement, BannerMotion>();

function motionOf(banner: HTMLElement) {
  const motion = motionByBanner.get(banner);
  if (!motion) throw new Error('attention banner was not built by buildAttentionBanner');
  return motion;
}

function canAnimate(element: HTMLElement) {
  return !document.hidden && typeof element.animate === 'function' && element.getClientRects().length > 0;
}

function prefersReducedMotion() {
  return reducedMotion?.matches ?? false;
}

function eased(frames: Keyframe[]) {
  return frames.map((frame) => ({ easing: EASE_OUT_EXPO, ...frame }));
}

export function buildAttentionBanner(hooks: AttentionBannerHooks, jumpKeys?: HTMLElement) {
  const banner = el('div', 'attention-banner');
  banner.setAttribute('role', 'status');
  banner.style.setProperty('--attention-head-tile-px', `${ATTENTION_TILE_SIZES_PX.headTile}px`);
  banner.style.setProperty('--attention-tile-px', `${ATTENTION_TILE_SIZES_PX.tile}px`);
  banner.style.setProperty('--attention-tile-gap-px', `${ATTENTION_TILE_SIZES_PX.tileGap}px`);
  banner.style.setProperty('--attention-overflow-px', `${ATTENTION_TILE_SIZES_PX.overflowSlot}px`);
  const chips = el('span', 'attention-banner-chips');
  const overflow = el('span', 'attention-tile-overflow');
  overflow.setAttribute('aria-hidden', 'true');
  overflow.hidden = true;
  chips.append(overflow);
  const allClearLine = el('span', 'attention-banner-line');
  allClearLine.setAttribute('aria-hidden', 'true');
  const status = el('span', 'attention-banner-status');
  status.append(chips, el('span', 'attention-banner-count'), allClearLine);
  const jumpRow = el('button', 'attention-banner-jump-row');
  jumpRow.type = 'button';
  jumpRow.append(status);
  if (jumpKeys) {
    jumpKeys.classList.add('attention-banner-jump');
    jumpRow.append(jumpKeys);
  }
  banner.addEventListener('click', () => hooks.onJump());
  banner.append(jumpRow);
  motionByBanner.set(banner, {
    hooks,
    tiles: [],
    tileById: new Map(),
    headId: null,
    flyingIds: new Set(),
    tetheredId: null,
    tetheredRow: null,
    lastAllClearLine: null,
    allClearLineTimer: null,
    pressAnimations: [],
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => renderTiles(banner)).observe(chips);
  paintAttentionBanner(banner, NO_ATTENTION, []);
  return banner;
}

export function paintAttentionBanner(banner: HTMLElement, counts: AttentionCounts, tiles: readonly AttentionTile[]) {
  const motion = motionOf(banner);
  motion.tiles = tiles;
  writeTextIfChanged(query(banner, '.attention-banner-count'), attentionSummaryText(counts));
  const isJumpable = tiles.length > 0;
  banner.toggleAttribute('data-empty', !isJumpable);
  banner.toggleAttribute('data-jumpable', isJumpable);
  if (isJumpable) endAllClearLine(banner, motion);
  renderTiles(banner);
}

function renderTiles(banner: HTMLElement) {
  const motion = motionOf(banner);
  const chips = query(banner, '.attention-banner-chips');
  const overflow = query(chips, '.attention-tile-overflow');
  const shouldAnimate = canAnimate(banner);
  const visibleTiles = motion.tiles.slice(0, fitAttentionTiles(chips.clientWidth, motion.tiles.length));
  const visibleIds = new Set(visibleTiles.map(({ id }) => id));
  const leftBeforeById = new Map<string, number>();
  if (shouldAnimate) for (const [id, tile] of motion.tileById) leftBeforeById.set(id, tile.getBoundingClientRect().left);
  const departingTiles = [...motion.tileById].filter(([id]) => !visibleIds.has(id));
  const pinnedOffsets = departingTiles.map(([, tile]) => ({ left: tile.offsetLeft, top: tile.offsetTop }));
  departingTiles.forEach(([id, tile], index) => {
    motion.tileById.delete(id);
    if (motion.flyingIds.has(id) || !shouldAnimate) {
      tile.remove();
      return;
    }
    leaveTile(tile, pinnedOffsets[index]);
  });
  const previousHeadId = motion.headId;
  const enteringTiles: HTMLSpanElement[] = [];
  let precedingTile: HTMLSpanElement | null = null;
  visibleTiles.forEach((attentionTile, index) => {
    const existing = motion.tileById.get(attentionTile.id);
    const tile = existing ?? buildTile(banner, attentionTile.id);
    if (!existing) {
      motion.tileById.set(attentionTile.id, tile);
      enteringTiles.push(tile);
    }
    paintTile(tile, attentionTile, index === 0);
    const isAlreadyInPlace = tile.parentElement === chips && previousSettledTileOf(tile) === precedingTile;
    if (!isAlreadyInPlace) chips.insertBefore(tile, overflow);
    precedingTile = tile;
  });
  const hiddenCount = motion.tiles.length - visibleTiles.length;
  writeHiddenIfChanged(overflow, hiddenCount === 0);
  writeTextIfChanged(overflow, `+${hiddenCount}`);
  writeAttributeIfChanged(overflow, 'title', `${hiddenCount} more after these`);
  motion.headId = visibleTiles[0]?.id ?? null;
  const headKind = motion.tiles[0]?.kind;
  if (headKind) banner.dataset.headKind = headKind;
  if (!headKind) delete banner.dataset.headKind;
  if (motion.tetheredId && !visibleIds.has(motion.tetheredId)) tetherAttentionTile(banner, null);
  if (!shouldAnimate) return;
  for (const tile of enteringTiles) animateTileEnter(tile);
  visibleTiles.forEach(({ id }, index) => {
    const tile = motion.tileById.get(id);
    const leftBefore = leftBeforeById.get(id);
    if (!tile || leftBefore === undefined) return;
    const shiftPx = leftBefore - tile.getBoundingClientRect().left;
    const isPromoted = id === motion.headId && id !== previousHeadId;
    if (isPromoted) {
      animateTilePromote(tile, shiftPx);
      return;
    }
    if (shiftPx !== 0) animateTileSlide(tile, shiftPx, index);
  });
}

function previousSettledTileOf(tile: Element) {
  let sibling = tile.previousElementSibling;
  while (sibling?.hasAttribute('data-leaving')) sibling = sibling.previousElementSibling;
  return sibling;
}

function buildTile(banner: HTMLElement, sessionId: string) {
  const tile = el('span', 'attention-tile');
  tile.setAttribute('role', 'img');
  tile.dataset.id = sessionId;
  const icon = el('span', 'attention-tile-icon');
  icon.setAttribute('aria-hidden', 'true');
  tile.append(icon);
  tile.addEventListener('pointerenter', () => tetherAttentionTile(banner, sessionId));
  tile.addEventListener('pointerleave', () => tetherAttentionTile(banner, null));
  return tile;
}

function paintTile(tile: HTMLSpanElement, { kind, name }: AttentionTile, isHead: boolean) {
  tile.dataset.kind = kind;
  tile.toggleAttribute('data-head', isHead);
  const label = `${name}, ${NEED_WORDS_BY_KIND[kind]}`;
  tile.title = label;
  tile.setAttribute('aria-label', label);
  paintStatusIcon(query(tile, '.attention-tile-icon'), ICON_BY_KIND[kind]);
}

function leaveTile(tile: HTMLSpanElement, pinnedOffset: { left: number; top: number }) {
  tile.toggleAttribute('data-leaving', true);
  tile.style.left = `${pinnedOffset.left}px`;
  tile.style.top = `${pinnedOffset.top}px`;
  const frames = prefersReducedMotion()
    ? [{ opacity: 1 }, { opacity: 0 }]
    : eased([{ transform: 'none', opacity: 1 }, { transform: 'scale(0.6)', opacity: 0 }]);
  const leave = tile.animate(frames, { duration: TILE_LEAVE_MS, fill: 'forwards' });
  leave.onfinish = () => tile.remove();
  leave.oncancel = () => tile.remove();
}

function animateTileEnter(tile: HTMLElement) {
  const frames = prefersReducedMotion()
    ? [{ opacity: 0 }, { opacity: 1 }]
    : eased([{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'none', opacity: 1 }]);
  tile.animate(frames, { duration: TILE_ENTER_MS });
}

function animateTileSlide(tile: HTMLElement, shiftPx: number, index: number) {
  if (prefersReducedMotion()) return;
  tile.animate(eased([{ transform: `translateX(${shiftPx}px)` }, { transform: 'none' }]), { duration: TILE_SLIDE_MS, delay: index * TILE_SLIDE_STAGGER_MS, fill: 'backwards' });
}

function animateTilePromote(tile: HTMLElement, shiftPx: number) {
  if (prefersReducedMotion()) {
    tile.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: TILE_PROMOTE_MS, easing: EASE_OUT_EXPO });
    return;
  }
  tile.animate(eased([
    { transform: `translateX(${shiftPx}px) scale(0.8)`, filter: 'brightness(1.8)' },
    { transform: 'scale(1.1)', offset: 0.6 },
    { transform: 'none', filter: 'none' },
  ]), { duration: TILE_PROMOTE_MS });
}

export function tetherAttentionTile(banner: HTMLElement, sessionId: string | null) {
  const motion = motionOf(banner);
  const tile = sessionId ? motion.tileById.get(sessionId) : undefined;
  const nextId = tile && sessionId ? sessionId : null;
  if (nextId === motion.tetheredId) return;
  if (motion.tetheredId) motion.tileById.get(motion.tetheredId)?.toggleAttribute('data-tethered', false);
  motion.tetheredRow?.toggleAttribute('data-tethered', false);
  motion.tetheredRow?.style.removeProperty('--tether');
  motion.tetheredId = nextId;
  motion.tetheredRow = null;
  if (!tile || !nextId) return;
  tile.toggleAttribute('data-tethered', true);
  const row = motion.hooks.rowFor(nextId);
  if (!row) return;
  const tileColor = getComputedStyle(tile).getPropertyValue('--tile').trim();
  if (tileColor) row.style.setProperty('--tether', tileColor);
  row.toggleAttribute('data-tethered', true);
  motion.tetheredRow = row;
}

function visibleRectOf(element: Element | null | undefined) {
  if (!element || element.getClientRects().length === 0) return null;
  return element.getBoundingClientRect();
}

export function sendAttentionTileToRow(banner: HTMLElement, sessionId: string, onLand: () => void) {
  const motion = motionOf(banner);
  if (motion.flyingIds.has(sessionId)) return;
  const tile = motion.tileById.get(sessionId);
  if (!tile || !canAnimate(banner)) {
    onLand();
    return;
  }
  tetherAttentionTile(banner, null);
  motion.flyingIds.add(sessionId);
  const row = motion.hooks.rowFor(sessionId);
  const fromRect = tile.getBoundingClientRect();
  const targetRect = visibleRectOf(row?.querySelector('.session-row-glyph') ?? row);
  const ghost = tile.cloneNode(true);
  if (!(ghost instanceof HTMLElement)) {
    motion.flyingIds.delete(sessionId);
    onLand();
    return;
  }
  ghost.classList.add('attention-tile-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.removeAttribute('aria-label');
  ghost.tabIndex = -1;
  ghost.style.left = `${fromRect.left}px`;
  ghost.style.top = `${fromRect.top}px`;
  ghost.style.width = `${fromRect.width}px`;
  ghost.style.height = `${fromRect.height}px`;
  document.body.append(ghost);
  tile.style.visibility = 'hidden';
  const flight = ghost.animate(flightFrames(fromRect, targetRect), flightTiming(targetRect));
  const land = () => {
    ghost.remove();
    motion.flyingIds.delete(sessionId);
    if (tile.isConnected) tile.style.visibility = '';
    onLand();
  };
  flight.onfinish = land;
  flight.oncancel = land;
}

function flightFrames(fromRect: DOMRect, targetRect: DOMRect | null): Keyframe[] {
  if (!targetRect || prefersReducedMotion()) return [{ opacity: 1 }, { opacity: 0 }];
  const shiftXPx = targetRect.left + targetRect.width / 2 - (fromRect.left + fromRect.width / 2);
  const shiftYPx = targetRect.top + targetRect.height / 2 - (fromRect.top + fromRect.height / 2);
  const landingScale = Math.min(1, targetRect.width / fromRect.width);
  return [
    { transform: 'none', opacity: 1 },
    { transform: 'translateY(-5px) scale(1.2)', opacity: 1, offset: 0.25 },
    { transform: `translate(${shiftXPx}px, ${shiftYPx}px) scale(${landingScale})`, opacity: 0.2 },
  ];
}

function flightTiming(targetRect: DOMRect | null): KeyframeAnimationOptions {
  if (!targetRect || prefersReducedMotion()) return { duration: TILE_FADE_MS, fill: 'forwards' };
  return { duration: TILE_FLY_MS, easing: EASE_IN_OUT_FLIGHT, fill: 'forwards' };
}

export function pressAttentionBanner(banner: HTMLElement) {
  const motion = motionOf(banner);
  if (banner.hasAttribute('data-empty')) showAllClearLine(banner, motion);
  for (const animation of motion.pressAnimations) animation.cancel();
  motion.pressAnimations = [];
  if (!canAnimate(banner)) return;
  const pressTiming = { duration: PRESS_MS };
  motion.pressAnimations.push(banner.animate(eased([{ opacity: 0 }, { opacity: 0.07, offset: 0.3 }, { opacity: 0 }]), { ...pressTiming, pseudoElement: '::after' }));
  if (prefersReducedMotion()) return;
  motion.pressAnimations.push(banner.animate(eased([{ transform: 'none' }, { transform: 'scale(0.97) translateY(1px)', offset: 0.3 }, { transform: 'none' }]), pressTiming));
  for (const keycap of banner.querySelectorAll<HTMLElement>('.attention-banner-jump .kbd')) {
    motion.pressAnimations.push(
      keycap.animate(eased([{ transform: 'none' }, { transform: `translateY(${KEYCAP_TRAVEL_PX}px)`, offset: 0.3 }, { transform: 'none' }]), pressTiming),
      keycap.animate(eased([{ transform: 'none' }, { transform: `translateY(-${KEYCAP_TRAVEL_PX}px)`, offset: 0.3 }, { transform: 'none' }]), { ...pressTiming, pseudoElement: '::after' }),
    );
  }
}

function pickAllClearLine(previousLine: string | null) {
  const candidates = ALL_CLEAR_LINES.filter((line) => line !== previousLine);
  return candidates[Math.floor(Math.random() * candidates.length)] ?? ALL_CLEAR_LINES[0];
}

function showAllClearLine(banner: HTMLElement, motion: BannerMotion) {
  const line = pickAllClearLine(motion.lastAllClearLine);
  motion.lastAllClearLine = line;
  query(banner, '.attention-banner-line').textContent = line;
  banner.toggleAttribute('data-all-clear-line', true);
  if (motion.allClearLineTimer !== null) window.clearTimeout(motion.allClearLineTimer);
  motion.allClearLineTimer = window.setTimeout(() => endAllClearLine(banner, motion), ALL_CLEAR_LINE_HOLD_MS);
}

function endAllClearLine(banner: HTMLElement, motion: BannerMotion) {
  if (motion.allClearLineTimer !== null) window.clearTimeout(motion.allClearLineTimer);
  motion.allClearLineTimer = null;
  banner.toggleAttribute('data-all-clear-line', false);
}
