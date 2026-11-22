import type { MatchAnalytics } from '#shared/contracts/wargames.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';

type InspectorTab = 'drama' | 'minds' | 'metrics' | 'ledger';

interface WargamesInspectorView {
  readonly element: HTMLElement;
  update(state: MatchState | null, analytics: MatchAnalytics | null): void;
}

function percentText(value: number | null): string {
  return value === null ? '-' : `${Math.round(value * 100)}%`;
}

export function createWargamesInspector(): WargamesInspectorView {
  let activeTab: InspectorTab = 'drama';
  let latestState: MatchState | null = null;
  let latestAnalytics: MatchAnalytics | null = null;

  const container = el('aside', 'wg-inspector');
  const tabBar = el('div', 'wg-inspector-tabs');
  const body = el('div', 'wg-inspector-body');
  const buttons = new Map<InspectorTab, HTMLButtonElement>();

  const tabs: readonly { id: InspectorTab; label: string }[] = [
    { id: 'drama', label: 'Drama' },
    { id: 'minds', label: 'Minds' },
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
    for (const item of latestAnalytics.highlights) {
      const card = el('article', 'wg-card');
      const head = el('div', 'wg-card-head');
      const badge = el('span', 'wg-badge', item.kind.replace('_', ' '));
      badge.dataset.tone = item.kind === 'contract_breach' ? 'breach' : 'warn';
      head.append(badge, el('span', 'wg-card-meta', `Tick ${item.tick} · ${item.actor} -> ${item.target}`));
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
    for (const seat of state.seats) {
      const card = el('article', 'wg-card');
      const head = el('div', 'wg-card-head');
      head.append(
        el('span', 'wg-card-title', `${seat.config.seatId.toUpperCase()} · ${seat.config.modelDisplay}`),
        el('span', 'wg-card-meta', seat.status),
      );
      const seatMessages = state.messages.filter((message) => message.from === seat.config.seatId && message.tick === state.tick);
      const saidText = seatMessages.length > 0 ? seatMessages.map((message) => message.text).join(' | ') : '(no messages this tick)';
      const orders = tickOrders?.[seat.config.seatId] ?? seat.sealedOrders;
      const orderedText = orders.length > 0 ? orders.map((order) => order.kind).join(', ') : '(hold)';
      const compare = el('div', 'wg-dm-compare');
      const saidBox = el('div', 'wg-dm-box');
      saidBox.append(el('div', 'wg-dm-label', 'Said'), el('div', 'wg-dm-text', saidText));
      const orderBox = el('div', 'wg-dm-box');
      orderBox.append(el('div', 'wg-dm-label', 'Ordered'), el('div', 'wg-dm-text', orderedText));
      compare.append(saidBox, orderBox);
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
      const card = el('article', 'wg-card');
      card.append(
        el('div', 'wg-card-title', `${seat.seatId.toUpperCase()} · ${seat.modelDisplay}`),
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
      const card = el('article', 'wg-card');
      card.append(
        el('div', 'wg-card-title', `Tick ${breach.tick}: ${breach.breacher} breached NAP with ${breach.victim}`),
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
      const card = el('article', 'wg-card');
      card.append(
        el('div', 'wg-card-title', `${contract.id} · ${contract.terms.kind.toUpperCase()} (${contract.status})`),
        el('div', 'wg-card-meta', `${contract.proposer} <-> ${contract.counterparty} · proposed tick ${contract.proposedTick}`),
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
    if (activeTab === 'minds') {
      renderMinds();
      return;
    }
    if (activeTab === 'metrics') {
      renderMetrics();
      return;
    }
    renderLedger();
  }

  function update(state: MatchState | null, analytics: MatchAnalytics | null): void {
    latestState = state;
    latestAnalytics = analytics;
    render();
  }

  render();
  return { element: container, update };
}
