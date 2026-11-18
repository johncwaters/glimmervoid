import { el } from '../dom-helpers.ts';
import { railFillPctOf, railTextOf } from './status-rail-core.ts';
import type { RailField } from './status-rail-core.ts';

interface StatusRail {
  element: HTMLElement;
  show(fields: readonly RailField[]): void;
}

function railFieldElementOf(field: RailField): HTMLElement {
  const fieldElement = el('span', 'chat-rail-field');
  fieldElement.dataset.kind = field.kind;
  fieldElement.append(el('span', 'chat-rail-text', railTextOf(field)));
  const fillPct = railFillPctOf(field);
  if (fillPct === null) return fieldElement;
  const meter = el('span', 'chat-rail-meter');
  const fill = el('span', 'chat-rail-meter-fill');
  fill.style.width = `${fillPct}%`;
  meter.append(fill);
  fieldElement.append(meter);
  return fieldElement;
}

export function createStatusRail(): StatusRail {
  const element = el('div', 'chat-rail');
  element.setAttribute('aria-label', 'Session status');
  const show = (fields: readonly RailField[]) => {
    element.replaceChildren(...fields.map(railFieldElementOf));
  };
  return { element, show };
}
