import { el } from '../dom-helpers.ts';
import { railFillPctOf, railTextOf } from './status-rail-core.ts';
import type { RailField } from './status-rail-core.ts';

type RailGroup = 'identity' | 'limits' | 'work';

const RAIL_GROUP_ORDER: readonly RailGroup[] = ['identity', 'limits', 'work'];

const RAIL_GROUP_BY_KIND: Readonly<Record<RailField['kind'], RailGroup>> = {
  model: 'identity',
  plan: 'limits',
  context: 'limits',
  callCost: 'work',
  sessionCost: 'work',
  subagents: 'work',
  mode: 'work',
};

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

function railGroupElementsOf(fields: readonly RailField[]): HTMLElement[] {
  return RAIL_GROUP_ORDER.flatMap((group) => {
    const fieldsInGroup = fields.filter((field) => RAIL_GROUP_BY_KIND[field.kind] === group);
    if (fieldsInGroup.length === 0) return [];
    const groupElement = el('span', 'chat-rail-group');
    groupElement.dataset.group = group;
    groupElement.append(...fieldsInGroup.map(railFieldElementOf));
    return [groupElement];
  });
}

export function createStatusRail(): StatusRail {
  const element = el('div', 'chat-rail');
  element.setAttribute('aria-label', 'Session status');
  const fieldsElement = el('div', 'chat-rail-fields');
  element.append(fieldsElement);
  const show = (fields: readonly RailField[]) => {
    fieldsElement.replaceChildren(...railGroupElementsOf(fields));
  };
  return { element, show };
}
