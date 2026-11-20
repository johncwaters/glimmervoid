import { el } from '../dom-helpers.ts';
import { createPressable } from '../ui/pressable.ts';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { railFillPctOf, railLevelOf, railTextOf } from './status-rail-core.ts';
import type { RailField } from './status-rail-core.ts';

type RailGroup = 'limits' | 'work';

const RAIL_GROUP_ORDER: readonly RailGroup[] = ['limits', 'work'];

const RAIL_GROUP_BY_KIND: Readonly<Record<Exclude<RailField['kind'], 'model'>, RailGroup>> = {
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
  fieldElement.dataset.level = railLevelOf(fillPct);
  const meter = el('span', 'chat-rail-meter');
  const fill = el('span', 'chat-rail-meter-fill');
  fill.style.width = `${fillPct}%`;
  meter.append(fill);
  fieldElement.append(meter);
  return fieldElement;
}

function railGroupElementsOf(fields: readonly RailField[]): HTMLElement[] {
  return RAIL_GROUP_ORDER.flatMap((group) => {
    const fieldsInGroup = fields.filter((field) => field.kind !== 'model' && RAIL_GROUP_BY_KIND[field.kind] === group);
    if (fieldsInGroup.length === 0) return [];
    const groupElement = el('span', 'chat-rail-group');
    groupElement.dataset.group = group;
    groupElement.append(...fieldsInGroup.map(railFieldElementOf));
    return [groupElement];
  });
}

function createModelField(): { element: HTMLElement; show(field: RailField | undefined): void } {
  const element = el('span', 'chat-rail-group');
  element.dataset.group = 'identity';
  const agentMark = el('span', 'chat-rail-agent');
  agentMark.hidden = true;
  const modelText = el('span', 'chat-rail-field');
  modelText.dataset.kind = 'model';
  const modelButton = createPressable('chat-rail-field chat-rail-model');
  modelButton.dataset.kind = 'model';
  modelButton.setAttribute('aria-haspopup', 'dialog');
  modelButton.addEventListener('click', () => {
    modelButton.dispatchEvent(new CustomEvent('chat-change-model', { bubbles: true, composed: true }));
  });
  element.append(agentMark, modelText, modelButton);
  const show = (field: RailField | undefined) => {
    element.hidden = field?.kind !== 'model';
    if (field?.kind !== 'model') return;
    paintAgentMark(agentMark, field.agent);
    const modelName = railTextOf(field);
    if (modelText.textContent !== modelName) modelText.textContent = modelName;
    if (modelButton.textContent !== modelName) modelButton.textContent = modelName;
    modelButton.setAttribute('aria-label', `Change model, ${modelName}`);
    modelText.hidden = field.canChange;
    modelButton.hidden = !field.canChange;
  };
  return { element, show };
}

export function createStatusRail(): StatusRail {
  const element = el('div', 'chat-rail');
  element.setAttribute('aria-label', 'Session status');
  const fieldsElement = el('div', 'chat-rail-fields');
  const modelField = createModelField();
  const readingsElement = el('span', 'chat-rail-readings');
  fieldsElement.append(modelField.element, readingsElement);
  element.append(fieldsElement);
  const show = (fields: readonly RailField[]) => {
    modelField.show(fields.find((field) => field.kind === 'model'));
    readingsElement.replaceChildren(...railGroupElementsOf(fields));
  };
  return { element, show };
}
