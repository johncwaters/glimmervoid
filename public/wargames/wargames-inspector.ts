import type { MatchAnalytics, SeatId } from '#shared/contracts/wargames.ts';
import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { SEAT_COLORS } from './wargames-map.ts';

type InspectorTab = 'drama' | 'metrics';

interface WargamesInspectorView {
  readonly element: HTMLElement;
  update(analytics: MatchAnalytics | null, spotlightSeatId: SeatId | null): void;
}

function createSeatSwatch(seatId: SeatId): HTMLElement {
  const swatch = el('span', 'wg-faction-swatch');
  swatch.style.background = SEAT_COLORS[seatId];
  return swatch;
}

function applySeatAccent(card: HTMLElement, seatId: SeatId, spotlightSeatId: SeatId | null): void {
  card.style.setProperty('--wg-seat-color', SEAT_COLORS[seatId]);
  if (spotlightSeatId === seatId) {
    card.dataset.spotlight = 'active';
    return;
  }
  if (spotlightSeatId !== null) {
    card.dataset.spotlight = 'dimmed';
  }
}

export function createWargamesInspector(): WargamesInspectorView {
  let activeTab: InspectorTab = 'drama';
  let latestAnalytics: MatchAnalytics | null = null;
  let latestSpotlightSeatId: SeatId | null = null;

  const container = el('aside', 'wg-inspector');
  const tabBar = el('div', 'wg-inspector-tabs');
  const body = el('div', 'wg-inspector-body');
  const buttons = new Map<InspectorTab, HTMLButtonElement>();

  const tabs: readonly { id: InspectorTab; label: string }[] = [
    { id: 'drama', label: 'Drama' },
    { id: 'metrics', label: 'Metrics' },
  ];

  for (const tab of tabs) {
    const tabButton = createPressable('wg-inspector-tab', tab.label);
    tabButton.addEventListener('click', () => {
      activeTab = tab.id;
      render();
    });
    buttons.set(tab.id, tabButton);
    tabBar.append(tabButton);
  }

  container.append(tabBar, body);

  function renderDrama(): void {
    if (!latestAnalytics || latestAnalytics.highlights.length === 0) {
      body.append(el('p', 'wg-empty-copy', 'No betrayals recorded yet.'));
      return;
    }
    const items = latestSpotlightSeatId
      ? latestAnalytics.highlights.filter(
        (item) => item.actor === latestSpotlightSeatId || item.target === latestSpotlightSeatId,
      )
      : latestAnalytics.highlights;
    if (items.length === 0) {
      body.append(el('p', 'wg-empty-copy', `No drama highlights recorded for ${latestSpotlightSeatId?.toUpperCase()}.`));
      return;
    }
    for (const item of items) {
      const card = el('article', 'wg-card wg-card-accented');
      applySeatAccent(card, item.actor, latestSpotlightSeatId);
      const head = el('div', 'wg-card-head');
      const headLeft = el('div', 'wg-card-title-row');
      const badge = el('span', 'wg-badge', item.kind);
      badge.dataset.tone = 'warn';
      headLeft.append(createSeatSwatch(item.actor), badge);
      head.append(headLeft, el('span', 'wg-card-meta', `Tick ${item.tick} · ${item.actor.toUpperCase()} -> ${item.target.toUpperCase()}`));
      card.append(head, el('div', 'wg-card-title', item.summary));
      if (item.relatedDmText || item.relatedOrderText) {
        const compare = el('div', 'wg-dm-compare');
        const dmBox = el('div', 'wg-dm-box');
        dmBox.append(el('div', 'wg-dm-label', 'Said in DM'), el('div', 'wg-dm-text', item.relatedDmText ?? '-'));
        const orderBox = el('div', 'wg-dm-box');
        orderBox.append(el('div', 'wg-dm-label', 'Ordered'), el('div', 'wg-dm-text', item.relatedOrderText ?? '-'));
        compare.append(dmBox, orderBox);
        card.append(compare);
      }
      body.append(card);
    }
  }

  function renderMetrics(): void {
    if (!latestAnalytics) {
      body.append(el('p', 'wg-empty-copy', 'No metrics available yet.'));
      return;
    }
    for (const seat of latestAnalytics.seats) {
      const card = el('article', 'wg-card wg-card-accented');
      applySeatAccent(card, seat.seatId, latestSpotlightSeatId);
      const titleRow = el('div', 'wg-card-title-row');
      titleRow.append(
        createSeatSwatch(seat.seatId),
        el('span', 'wg-card-title', `${seat.seatId.toUpperCase()} · ${seat.modelDisplay}`),
      );
      card.append(
        titleRow,
        el('div', 'wg-card-meta', `Villages: ${seat.villagesHeld} · Messages: ${seat.messagesSent} (${seat.publicMessages} public)`),
        el('div', 'wg-card-meta', `Betrayals: ${seat.betrayals} · First: ${seat.firstBetrayalTick ?? '-'}`),
      );
      body.append(card);
    }
  }

  function render(): void {
    for (const [id, tabButton] of buttons) {
      tabButton.dataset.state = id === activeTab ? 'active' : 'idle';
    }
    body.replaceChildren();
    if (activeTab === 'drama') {
      renderDrama();
      return;
    }
    renderMetrics();
  }

  function update(analytics: MatchAnalytics | null, spotlightSeatId: SeatId | null): void {
    latestAnalytics = analytics;
    latestSpotlightSeatId = spotlightSeatId;
    render();
  }

  render();
  return { element: container, update };
}
