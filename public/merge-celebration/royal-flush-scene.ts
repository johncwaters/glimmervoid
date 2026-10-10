import { el } from '../dom-helpers.ts';
import { ROYAL_FLUSH_RANKS, royalFlushCardLayout, royalFlushCardStyleProperties, royalFlushTableStyleProperties } from './royal-flush-core.ts';
import type { MergeCelebrationScene } from './scenes.ts';

const HEART_SVG = '<svg viewBox="0 0 10 9" aria-hidden="true"><path d="M5 8.5C5 8.5 0 5.3 0 2.6C0 1.1 1.2 0 2.6 0C3.6 0 4.5 .6 5 1.4C5.5 .6 6.4 0 7.4 0C8.8 0 10 1.1 10 2.6C10 5.3 5 8.5 5 8.5Z"/></svg>';

function createCard(rank: string, cardIndex: number): HTMLElement {
  const deal = el('div', 'merge-flush-deal');
  for (const [propertyName, value] of royalFlushCardStyleProperties(royalFlushCardLayout(cardIndex))) deal.style.setProperty(propertyName, value);
  const hop = el('div', 'merge-flush-hop');
  const card = el('div', 'merge-flush-card');
  const face = el('div', 'merge-flush-face');
  face.append(el('span', 'merge-flush-rank', rank));
  face.insertAdjacentHTML('beforeend', HEART_SVG);
  card.append(el('div', 'merge-flush-back'), face);
  hop.append(card);
  deal.append(hop);
  return deal;
}

function buildRoyalFlushScene(): HTMLElement {
  const table = el('div', 'merge-flush-table');
  for (const [propertyName, value] of royalFlushTableStyleProperties()) table.style.setProperty(propertyName, value);
  ROYAL_FLUSH_RANKS.forEach((rank, cardIndex) => table.append(createCard(rank, cardIndex)));
  return table;
}

export const royalFlushScene: MergeCelebrationScene = { title: 'ROYAL FLUSH!', buildScene: buildRoyalFlushScene };
