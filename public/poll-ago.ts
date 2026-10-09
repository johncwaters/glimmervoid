
import { elapsedText } from '#shared/display-text.ts';
import { onSessionTick } from './session-card/session-tick.ts';

export function formatDuration(ms: unknown) {
  return elapsedText(Number(ms) || 0, { rounding: 'round', wording: 'compact', suffix: '', justNowBelowSeconds: 0 });
}

export function formatAgo(ts: number | null | undefined) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 'never';
  return `${formatDuration(Date.now() - ts)} ago`;
}

const polledText = (ts: number | null | undefined) => `polled ${formatAgo(ts)}`;

export function createPollAgoTicker(getRoot: () => Element | null) {
  interface TrackedReadout {
    el: HTMLElement;
    ts: number | null | undefined;
    format: (ts: number | null | undefined) => string;
  }
  let tracked: TrackedReadout[] = [];
  let painters: (() => void)[] = [];
  let unsubscribe: (() => boolean) | null = null;

  const paint = (item: TrackedReadout) => {
    const next = item.format(item.ts);
    if (item.el.textContent === next) return;
    item.el.textContent = next;
  };

  const refresh = () => {
    const root = getRoot();
    if (!root || root.closest('[hidden]')) return;
    for (const item of tracked) paint(item);
    for (const painter of painters) painter();
  };

  return {
    track(target: HTMLElement, ts: number | null | undefined, format: (ts: number | null | undefined) => string = polledText) {
      const item = { el: target, ts, format };
      paint(item);
      tracked.push(item);
    },
    onTick(painter: () => void) {
      painters.push(painter);
    },
    reset() {
      tracked = [];
      painters = [];
    },
    ensure() {
      if (unsubscribe) return;
      unsubscribe = onSessionTick(refresh);
    },
  };
}
