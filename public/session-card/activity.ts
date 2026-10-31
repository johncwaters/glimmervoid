import { STATES } from '#shared/states.ts';
import type { SessionUi } from './card-registry.ts';

const BEAT_THROTTLE_MS = 320;
const QUIET_AFTER_MS = 8000;

export type ActivityRenderKind = 'beat' | 'flag';
type ActivityRenderer = (ui: SessionUi, kind: ActivityRenderKind) => void;

const renderers = new Set<ActivityRenderer>();
export function addActivityRenderer(fn: ActivityRenderer) { renderers.add(fn); }
const render = (ui: SessionUi, kind: ActivityRenderKind) => { for (const fn of renderers) fn(ui, kind); };

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

export function pulseActivityGlyph(glyph: HTMLElement | null | undefined) {
  if (reducedMotion?.matches || document.hidden || !glyph) return;
  const beat = glyph.querySelector('.status-icon-beat:not([data-leaving])');
  const ping = glyph.querySelector('.status-icon-ping:not([data-leaving])');
  beat?.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: 0.3 }, { transform: 'scale(1)' }],
    { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', composite: 'add' },
  );
  if (!ping) return;
  for (const animation of ping.getAnimations()) animation.cancel();
  ping.animate([{ transform: 'scale(1)', opacity: 0.75 }, { transform: 'scale(1.75)', opacity: 0 }], { duration: 650, easing: 'ease-out' });
}

export function noteSessionOutput(ui: SessionUi | null | undefined) {
  if (!ui || ui.currentState !== STATES.RUNNING) return;
  const now = performance.now();
  ui._lastOutputAt = now;
  if (now - (ui._activityGate || 0) < BEAT_THROTTLE_MS) return;
  ui._activityGate = now;
  if (ui._activity === 'quiet') { ui._activity = 'active'; render(ui, 'flag'); }
  render(ui, 'beat');
}

export function refreshSessionActivity(ui: SessionUi | null | undefined) {
  if (!ui || ui.currentState !== STATES.RUNNING) return;
  const next = performance.now() - (ui._lastOutputAt || 0) >= QUIET_AFTER_MS ? 'quiet' : 'active';
  if (ui._activity !== next) { ui._activity = next; render(ui, 'flag'); }
}

export function setRunningActivity(ui: SessionUi | null | undefined, running: boolean) {
  if (!ui) return;
  if (running) {
    ui._lastOutputAt = performance.now();
    ui._activityGate = 0;
    ui._activity = 'active';
  }
  if (!running) ui._activity = undefined;
  render(ui, 'flag');
}
