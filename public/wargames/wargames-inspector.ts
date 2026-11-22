import type { MatchAnalytics, OrderItem, SeatId } from '#shared/contracts/wargames.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { SEAT_COLORS } from './wargames-map.ts';

type InspectorTab = 'minds' | 'drama' | 'metrics' | 'ledger';

interface WargamesInspectorView {
  readonly element: HTMLElement;
  update(state: MatchState | null, analytics: MatchAnalytics | null, spotlightSeatId: SeatId | null): void;
}

function percentText(value: number | null): string {
  return value === null ? '-' : `${Math.round(value * 100)}%`;
}

function capitalizeWord(word: string): string {
  if (word.length === 0) return word;
  return `${word[0].toUpperCase()}${word.slice(1)}`;
}

function formatTroopBreakdown(troops: { raider: number; guard: number; envoy: number }): string {
  const parts: string[] = [];
  if (troops.raider > 0) parts.push(`${troops.raider}R`);
  if (troops.guard > 0) parts.push(`${troops.guard}G`);
  if (troops.envoy > 0) parts.push(`${troops.envoy}E`);
  return parts.join(' ');
}

function formatOrder(order: OrderItem): string {
  switch (order.kind) {
    case 'build':
      return `Build ${capitalizeWord(order.building)} @#${order.hexIndex}`;
    case 'train':
      return `Train ${order.count} ${capitalizeWord(order.troop)} @#${order.hexIndex}`;
    case 'march': {
      const troopSummary = formatTroopBreakdown(order.troops);
      return troopSummary
        ? `March #${order.fromHexIndex}->#${order.toHexIndex} (${troopSummary})`
        : `March #${order.fromHexIndex}->#${order.toHexIndex}`;
    }
    case 'scout':
      return `Scout #${order.fromHexIndex}->#${order.toHexIndex}`;
    case 'tribe_join':
      return `Join tribe ${order.partner.toUpperCase()}`;
    case 'tribe_leave':
      return 'Leave tribe';
  }
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
  let activeTab: InspectorTab = 'minds';
  let latestState: MatchState | null = null;
  let latestAnalytics: MatchAnalytics | null = null;
  let latestSpotlightSeatId: SeatId | null = null;

  const container = el('aside', 'wg-inspector');
  const tabBar = el('div', 'wg-inspector-tabs');
  const body = el('div', 'wg-inspector-body');
  const buttons = new Map<InspectorTab, HTMLButtonElement>();

  const tabs: readonly { id: InspectorTab; label: string }[] = [
    { id: 'minds', label: 'Minds' },
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

  function renderMinds(): void {
    const state = latestState;
    if (!state) {
      body.append(el('p', 'wg-empty-copy', 'Watch a match to inspect each seat\'s private notes and orders.'));
      return;
    }
    const tickOrders = state.ordersByTick[state.tick] ?? state.ordersByTick[Math.max(1, state.tick - 1)];
    const seats = latestSpotlightSeatId
      ? state.seats.filter((seat) => seat.config.seatId === latestSpotlightSeatId)
      : state.seats;

    if (latestSpotlightSeatId) {
      body.append(el('div', 'wg-section-label', `Spotlight: ${latestSpotlightSeatId.toUpperCase()}`));
    }

    for (const seat of seats) {
      const seatId = seat.config.seatId;
      const card = el('article', 'wg-card wg-card-accented');
      applySeatAccent(card, seatId, latestSpotlightSeatId);

      const head = el('div', 'wg-card-head');
      const titleRow = el('div', 'wg-card-title-row');
      titleRow.append(
        createSeatSwatch(seatId),
        el('span', 'wg-card-title', `${seatId.toUpperCase()} ${seat.config.label} · ${seat.config.modelDisplay}`),
      );
      head.append(titleRow, el('span', 'wg-card-meta', seat.status));

      const seatMessages = state.messages.filter((message) => message.from === seatId && message.tick === state.tick);
      const saidText = seatMessages.length > 0
        ? seatMessages.map((message) => (message.to ? `[${message.to.toUpperCase()}] ${message.text}` : message.text)).join(' | ')
        : '(no messages this tick)';
      const orders = tickOrders?.[seatId] ?? seat.sealedOrders;
      const orderedText = orders.length > 0 ? orders.map(formatOrder).join(', ') : '(hold)';

      const compare = el('div', 'wg-dm-compare');
      const orderBox = el('div', 'wg-dm-box');
      orderBox.append(el('div', 'wg-dm-label', 'Ordered'), el('div', 'wg-dm-text', orderedText));
      const saidBox = el('div', 'wg-dm-box');
      saidBox.append(el('div', 'wg-dm-label', 'Said'), el('div', 'wg-dm-text', saidText));
      compare.append(orderBox, saidBox);

      const notePre = el('pre', 'wg-note-box', seat.note || '(empty 4 KB scratchpad)');
      card.append(head, compare, notePre);
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
    if (activeTab === 'minds') {
      renderMinds();
      return;
    }
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
