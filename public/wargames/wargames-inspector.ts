import type { MatchAnalytics, SeatId } from '#shared/contracts/wargames.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { SEAT_COLORS } from './wargames-map.ts';

type InspectorTab = 'drama' | 'metrics' | 'ledger';

interface WargamesInspectorView {
  readonly element: HTMLElement;
  update(state: MatchState | null, analytics: MatchAnalytics | null, spotlightSeatId: SeatId | null): void;
}

function percentText(value: number | null): string {
  return value === null ? '-' : `${Math.round(value * 100)}%`;
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
  let latestState: MatchState | null = null;
  let latestAnalytics: MatchAnalytics | null = null;
  let latestSpotlightSeatId: SeatId | null = null;

  const container = el('aside', 'wg-inspector');
  const tabBar = el('div', 'wg-inspector-tabs');
  const body = el('div', 'wg-inspector-body');
  const buttons = new Map<InspectorTab, HTMLButtonElement>();

  const tabs: readonly { id: InspectorTab; label: string }[] = [
    { id: 'drama', label: 'Drama' },
    { id: 'metrics', label: 'Metrics' },
    { id: 'ledger', label: 'Ledger' },
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
      body.append(el('p', 'wg-empty-copy', 'No betrayals, NAP breaches, or forged reports recorded yet.'));
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
      const badge = el('span', 'wg-badge', item.kind.replace('_', ' '));
      badge.dataset.tone = item.kind === 'contract_breach' ? 'breach' : 'warn';
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
    const summaryCard = el('article', 'wg-card');
    summaryCard.append(
      el('div', 'wg-card-title', 'Match research metrics'),
      el('div', 'wg-card-meta', `Avg coalition lifetime: ${latestAnalytics.avgCoalitionLifetimeTicks === null ? '-' : `${latestAnalytics.avgCoalitionLifetimeTicks.toFixed(1)} ticks`}`),
      el('div', 'wg-card-meta', `Forged report detection: ${percentText(latestAnalytics.forgedReportDetectionRate)}`),
      el('div', 'wg-card-meta', `Same-model collusion: ${percentText(latestAnalytics.sameModelCollusionRate)}`),
    );
    body.append(summaryCard);
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
        el('div', 'wg-card-meta', `Villages: ${seat.villagesHeld} · Talk kept: ${percentText(seat.promisesKeptTalkRate)} · Contract kept: ${percentText(seat.promisesKeptContractRate)}`),
        el('div', 'wg-card-meta', `First betrayal: ${seat.firstBetrayalTick ?? '-'} · Forgeries: ${seat.forgedReportsSent} (${seat.forgedReportsDetected} caught)`),
      );
      body.append(card);
    }
  }

  function renderLedger(): void {
    if (!latestState) {
      body.append(el('p', 'wg-empty-copy', 'No contracts or breaches yet.'));
      return;
    }
    const breachesTitle = el('div', 'wg-section-label', 'Public breach ledger');
    body.append(breachesTitle);
    if (latestState.ledger.length === 0) {
      body.append(el('p', 'wg-empty-copy', 'No contract breaches recorded.'));
    }
    for (const breach of latestState.ledger) {
      const card = el('article', 'wg-card wg-card-accented');
      applySeatAccent(card, breach.breacher, latestSpotlightSeatId);
      const titleRow = el('div', 'wg-card-title-row');
      titleRow.append(
        createSeatSwatch(breach.breacher),
        el('span', 'wg-card-title', `Tick ${breach.tick}: ${breach.breacher.toUpperCase()} breached NAP with ${breach.victim.toUpperCase()}`),
      );
      card.append(
        titleRow,
        el('div', 'wg-card-meta', `Collateral transferred: ${breach.collateralTransferred.grain} grain / ${breach.collateralTransferred.ore} ore`),
      );
      body.append(card);
    }
    body.append(el('div', 'wg-section-label', 'Contracts'));
    const contracts = [...latestState.contracts.values()];
    if (contracts.length === 0) {
      body.append(el('p', 'wg-empty-copy', 'No contracts proposed.'));
    }
    for (const contract of contracts) {
      const card = el('article', 'wg-card wg-card-accented');
      applySeatAccent(card, contract.proposer, latestSpotlightSeatId);
      const titleRow = el('div', 'wg-card-title-row');
      titleRow.append(
        createSeatSwatch(contract.proposer),
        el('span', 'wg-card-title', `${contract.id} · ${contract.terms.kind.toUpperCase()} (${contract.status})`),
      );
      card.append(
        titleRow,
        el('div', 'wg-card-meta', `${contract.proposer.toUpperCase()} <-> ${contract.counterparty.toUpperCase()} · proposed tick ${contract.proposedTick}`),
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
    if (activeTab === 'metrics') {
      renderMetrics();
      return;
    }
    renderLedger();
  }

  function update(state: MatchState | null, analytics: MatchAnalytics | null, spotlightSeatId: SeatId | null): void {
    latestState = state;
    latestAnalytics = analytics;
    latestSpotlightSeatId = spotlightSeatId;
    render();
  }

  render();
  return { element: container, update };
}
