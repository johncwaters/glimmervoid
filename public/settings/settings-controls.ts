import type { SettingsRange } from '#shared/settings-ranges.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { createLineIcon } from '../svg-dom.ts';
import { notificationsSupported } from '../notifications.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { readTeamReviewEnvironment, teamReviewSuggestions } from './team-review-settings-core.ts';
import type { SettingsSetting } from '#shared/settings/registry.ts';
import { choicePresentation, displayRange, draftCommitOf, listValue, needsDangerConfirmation, numberDraftOf, secretEnvironmentSource } from './settings-view-core.ts';
import { moveViewId, orderViewIds } from '../view-registry-core.ts';
import { buildShortcutKeys, SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { recordNextAttentionKey, shortcutChord } from '../shortcuts-core.ts';
import { settingsFeatureTabViews, requestTeamReviewEnvironmentOnce } from './settings-store.ts';
import { draftByControl, settingsPayload, storedValue, storedValues, viewMap } from './settings-panel-state.ts';
import { renderReadout } from './settings-readouts.ts';
import { commitSetting, setFieldError } from './settings-save.ts';

const MOVE_UP_ICON_PATH = 'M4 10L8 6L12 10';
const MOVE_DOWN_ICON_PATH = 'M4 6L8 10L12 6';
const GRIP_ICON_PATH = 'M6 4h0.01M10 4h0.01M6 8h0.01M10 8h0.01M6 12h0.01M10 12h0.01';
const SEGMENT_STEP_BY_KEY: Readonly<Record<string, number>> = Object.freeze({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 });

function inputMinimum(setting: SettingsSetting, range: SettingsRange) {
  if (!range.exclusiveMin) return range.min;
  if (setting.integer === false) return undefined;
  return range.min + 1;
}

function renderToggle(setting: SettingsSetting) {
  const wrapper = el('div', 'settings-view-toggle-wrap');
  const input = el('input', 'settings-view-switch');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.checked = storedValue(setting) === true;
  if (setting.id === 'desktop-notifications' && !notificationsSupported()) {
    input.checked = false;
    input.disabled = true;
  }
  input.setAttribute('aria-labelledby', setting.id);
  input.addEventListener('change', () => {
    const next = input.checked;
    if (needsDangerConfirmation(setting, next)) {
      input.checked = false;
      openConfirmDialog({
        title: setting.title,
        message: setting.warning ?? '',
        confirmLabel: 'Turn on',
        danger: true,
        onConfirm: () => commitSetting(setting, true),
      });
      return;
    }
    commitSetting(setting, next);
  });
  wrapper.appendChild(input);
  return wrapper;
}

function attachSuggestions(setting: SettingsSetting, input: HTMLInputElement) {
  if (!setting.suggestionsFrom) return;
  const environment = readTeamReviewEnvironment(settingsPayload.teamReviewEnvironment);
  if (environment?.agents.length === 0) requestTeamReviewEnvironmentOnce();
  const suggestions = teamReviewSuggestions(setting.suggestionsFrom, environment, storedValues);
  const listId = `${setting.id}-suggestions`;
  document.getElementById(listId)?.remove();
  const datalist = el('datalist');
  datalist.id = listId;
  for (const suggestion of suggestions) {
    const option = el('option');
    option.value = suggestion.value;
    option.label = suggestion.label;
    datalist.appendChild(option);
  }
  document.body.appendChild(datalist);
  input.setAttribute('list', listId);
  input.placeholder = 'Agent default';
  if (setting.suggestionsFrom === 'review-skills') input.placeholder = 'No skill';
}

function renderShortcutKey(setting: SettingsSetting) {
  const wrapper = el('div', 'settings-view-shortcut-key');
  const chord = buildShortcutKeys(shortcutChord('next-attention', SHORTCUT_PLATFORM, String(storedValue(setting))));
  const record = button({ variant: 'secondary', label: 'Record', action: 'record-shortcut-key' });
  const prompt = el('span', 'settings-view-shortcut-key-prompt');
  prompt.setAttribute('role', 'status');
  record.addEventListener('click', () => recordShortcutKey(setting, wrapper, record, prompt));
  wrapper.append(chord, record, prompt);
  return wrapper;
}

function recordShortcutKey(setting: SettingsSetting, row: HTMLElement, record: HTMLButtonElement, prompt: HTMLElement) {
  const stopRecording = () => {
    window.removeEventListener('keydown', onRecordingKeydown, true);
    window.removeEventListener('pointerdown', onLeavingRow, true);
    window.removeEventListener('focusin', onLeavingRow, true);
    record.disabled = false;
    prompt.textContent = '';
  };
  const onLeavingRow = (event: Event) => {
    if (event.target instanceof Node && row.contains(event.target)) return;
    stopRecording();
  };
  const onRecordingKeydown = (event: KeyboardEvent) => {
    if (!record.isConnected || !record.checkVisibility()) {
      stopRecording();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const outcome = recordNextAttentionKey(event, SHORTCUT_PLATFORM);
    if (outcome.kind === 'ignored') return;
    if (outcome.kind === 'refused') {
      setFieldError(setting, outcome.reason);
      return;
    }
    stopRecording();
    setFieldError(setting, null);
    record.focus();
    if (outcome.kind === 'recorded') commitSetting(setting, outcome.keyCode);
  };
  setFieldError(setting, null);
  record.disabled = true;
  prompt.textContent = 'Press the new shortcut, or Esc to cancel.';
  window.addEventListener('keydown', onRecordingKeydown, true);
  window.addEventListener('pointerdown', onLeavingRow, true);
  window.addEventListener('focusin', onLeavingRow, true);
}

function bindDraftCommit(input: HTMLInputElement, commitDraft: () => void, restoreDraft: () => void) {
  input.addEventListener('blur', commitDraft);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft();
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    restoreDraft();
  });
}

function isTextField(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLInputElement && ['text', 'number', 'password'].includes(element.type);
}

function trackDraft(setting: SettingsSetting, field: HTMLInputElement | HTMLTextAreaElement) {
  draftByControl.set(field, { base: storedValue(setting), isDirty: false });
  field.addEventListener('input', () => {
    const draft = draftByControl.get(field);
    if (draft) draft.isDirty = true;
  });
}

function restoreFieldDraft(setting: SettingsSetting, field: HTMLInputElement | HTMLTextAreaElement, storedText: string) {
  if (field.value !== storedText) field.value = storedText;
  draftByControl.set(field, { base: storedValue(setting), isDirty: false });
  setFieldError(setting, null);
}

function commitFieldDraft(setting: SettingsSetting, field: HTMLInputElement | HTMLTextAreaElement, storedText: string, isUnparsable = false) {
  const draft = draftByControl.get(field);
  if (!draft) return;
  const decision = draftCommitOf(viewMap, setting, draft, field.value, storedValues, isUnparsable);
  if (decision.kind === 'invalid') {
    setFieldError(setting, decision.error);
    return;
  }
  if (decision.kind === 'unchanged') {
    restoreFieldDraft(setting, field, storedText);
    return;
  }
  if (needsDangerConfirmation(setting, decision.value)) {
    restoreFieldDraft(setting, field, storedText);
    openConfirmDialog({
      title: setting.title,
      message: setting.warning ?? '',
      confirmLabel: 'Save',
      danger: true,
      onConfirm: () => commitSetting(setting, decision.value),
    });
    return;
  }
  draftByControl.set(field, { base: decision.value, isDirty: false });
  commitSetting(setting, decision.value);
}

function renderInput(setting: SettingsSetting) {
  const input = el('input', 'settings-view-input');
  input.type = setting.control === 'password' ? 'password' : 'text';
  const stored = () => String(storedValue(setting) ?? '');
  input.value = stored();
  if (setting.control === 'password') {
    input.value = '';
    input.placeholder = stored() ? 'Configured' : 'Not configured';
  }
  const environmentSource = secretEnvironmentSource(setting, settingsPayload);
  if (environmentSource) {
    input.disabled = true;
    input.setAttribute('aria-description', `Supplied by ${environmentSource}`);
  }
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-labelledby', setting.id);
  attachSuggestions(setting, input);
  trackDraft(setting, input);
  const commitInputDraft = () => {
    if (setting.control === 'password') {
      const secret = input.value;
      if (secret === '') return;
      restoreFieldDraft(setting, input, '');
      commitSetting(setting, secret);
      return;
    }
    commitFieldDraft(setting, input, stored());
  };
  bindDraftCommit(input, commitInputDraft, () => restoreFieldDraft(setting, input, setting.control === 'password' ? '' : stored()));
  return input;
}

function renderNumber(setting: SettingsSetting) {
  const input = el('input', 'settings-view-input');
  const range = displayRange(setting);
  input.type = 'number';
  const stored = () => numberDraftOf(storedValue(setting));
  input.value = stored();
  input.step = setting.integer === false ? String(setting.step ?? 'any') : '1';
  const minimum = range ? inputMinimum(setting, range) : undefined;
  if (minimum != null) input.min = String(minimum);
  if (range?.max != null) input.max = String(range.max);
  input.autocomplete = 'off';
  input.setAttribute('aria-labelledby', setting.id);
  trackDraft(setting, input);
  bindDraftCommit(input, () => commitFieldDraft(setting, input, stored(), input.validity.badInput), () => restoreFieldDraft(setting, input, stored()));
  const unitLabel = setting.unit?.label;
  if (!unitLabel) return input;
  const field = el('div', 'settings-view-number');
  const unit = el('span', 'settings-view-unit', unitLabel);
  unit.setAttribute('aria-hidden', 'true');
  input.setAttribute('aria-description', unitLabel);
  field.append(input, unit);
  return field;
}

function selectSegment(group: HTMLElement, selectedValue: string) {
  const segments = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const hasSelection = segments.some((segment) => segment.dataset.value === selectedValue);
  for (const [index, segment] of segments.entries()) {
    const isSelected = segment.dataset.value === selectedValue;
    segment.setAttribute('aria-checked', String(isSelected));
    segment.tabIndex = isSelected || (!hasSelection && index === 0) ? 0 : -1;
  }
}

function chooseSegment(setting: SettingsSetting, group: HTMLElement, value: string) {
  if (value === String(storedValue(setting))) return;
  selectSegment(group, value);
  commitSetting(setting, value);
  selectSegment(group, String(storedValue(setting)));
}

function renderSegmented(setting: SettingsSetting) {
  const group = el('div', 'settings-view-segmented');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', setting.id);
  const choices = setting.options ?? [];
  for (const choice of choices) {
    const segment = createPressable('settings-view-segment', choice.label);
    segment.dataset.value = choice.value;
    segment.setAttribute('role', 'radio');
    segment.addEventListener('click', () => chooseSegment(setting, group, choice.value));
    group.appendChild(segment);
  }
  group.addEventListener('keydown', (event) => {
    const step = SEGMENT_STEP_BY_KEY[event.key];
    if (!step || choices.length === 0) return;
    event.preventDefault();
    const currentIndex = Math.max(0, choices.findIndex((choice) => choice.value === String(storedValue(setting))));
    const next = choices[(currentIndex + step + choices.length) % choices.length];
    chooseSegment(setting, group, next.value);
    group.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  });
  selectSegment(group, String(storedValue(setting)));
  return group;
}

function renderSelect(setting: SettingsSetting) {
  const select = el('select', 'settings-view-input');
  select.setAttribute('aria-labelledby', setting.id);
  for (const choice of setting.options ?? []) {
    const option = el('option', null, choice.label);
    option.value = choice.value;
    select.appendChild(option);
  }
  select.value = String(storedValue(setting));
  select.addEventListener('change', () => commitSetting(setting, select.value));
  return select;
}

function listHintText(setting: SettingsSetting, entries: readonly string[]) {
  const format = setting.valueKind === 'posthog-projects'
    ? 'One project id per line, or none. Shift+Enter for a new line.'
    : 'One per line. Shift+Enter for a new line.';
  if (entries.length > 0 || !setting.listEmptyText) return format;
  return `${setting.listEmptyText} ${format}`;
}

function renderList(setting: SettingsSetting) {
  const input = el('textarea', 'settings-view-input settings-view-list-input');
  const storedEntries = () => listValue(storedValue(setting));
  const storedText = () => storedEntries().join('\n');
  input.rows = 3;
  input.value = storedText();
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = setting.listPlaceholder ?? '';
  input.setAttribute('aria-labelledby', setting.id);
  trackDraft(setting, input);
  input.addEventListener('blur', () => commitFieldDraft(setting, input, storedText()));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      restoreFieldDraft(setting, input, storedText());
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    commitFieldDraft(setting, input, storedText());
  });
  const wrapper = el('div', 'settings-view-list');
  wrapper.append(input, el('span', 'settings-view-list-hint', listHintText(setting, storedEntries())));
  return wrapper;
}

let lastTabOrderMoveKey: string | null = null;
let draggedTabOrderViewId: string | null = null;

function renderTabOrder(setting: SettingsSetting) {
  const featureTabViews = settingsFeatureTabViews();
  const labelByViewId = new Map(featureTabViews.map((view) => [view.view, view.label]));
  const orderedViewIds = orderViewIds(featureTabViews.map((view) => view.view), listValue(storedValue(setting)));
  const list = el('ol', 'settings-view-tab-order');
  list.setAttribute('aria-labelledby', setting.id);
  for (const [index, viewId] of orderedViewIds.entries()) {
    const label = labelByViewId.get(viewId) ?? viewId;
    const item = el('li', 'settings-view-tab-order-item');
    const grip = el('span', 'settings-view-tab-order-grip');
    grip.setAttribute('aria-hidden', 'true');
    grip.appendChild(createLineIcon(GRIP_ICON_PATH, '2.4'));
    item.append(
      grip,
      el('span', 'settings-view-tab-order-label', label),
      buildTabOrderMove(setting, orderedViewIds, viewId, index - 1, 'up', `Move ${label} up`),
      buildTabOrderMove(setting, orderedViewIds, viewId, index + 1, 'down', `Move ${label} down`),
    );
    makeTabOrderItemDraggable(setting, item, orderedViewIds, viewId, index);
    list.append(item);
  }
  return list;
}

function makeTabOrderItemDraggable(setting: SettingsSetting, item: HTMLElement, orderedViewIds: readonly string[], viewId: string, index: number) {
  item.draggable = true;
  item.addEventListener('dragstart', (event) => {
    draggedTabOrderViewId = viewId;
    event.dataTransfer?.setData('text/plain', viewId);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  item.addEventListener('dragend', () => { draggedTabOrderViewId = null; });
  item.addEventListener('dragover', (event) => {
    if (!draggedTabOrderViewId || draggedTabOrderViewId === viewId) return;
    event.preventDefault();
    item.dataset.dropTarget = orderedViewIds.indexOf(draggedTabOrderViewId) < index ? 'after' : 'before';
  });
  item.addEventListener('dragleave', () => delete item.dataset.dropTarget);
  item.addEventListener('drop', (event) => {
    event.preventDefault();
    delete item.dataset.dropTarget;
    const movedViewId = draggedTabOrderViewId;
    draggedTabOrderViewId = null;
    if (!movedViewId || movedViewId === viewId) return;
    commitSetting(setting, moveViewId(orderedViewIds, movedViewId, index));
  });
}

function buildTabOrderMove(
  setting: SettingsSetting, orderedViewIds: readonly string[], viewId: string, targetIndex: number, direction: 'up' | 'down', accessibleName: string,
) {
  const moveKey = `${viewId}:${direction}`;
  const moveButton = button({
    variant: 'icon',
    size: 'small',
    label: accessibleName,
    icon: createLineIcon(direction === 'up' ? MOVE_UP_ICON_PATH : MOVE_DOWN_ICON_PATH),
    action: `move-tab-${direction}`,
    disabled: targetIndex < 0 || targetIndex >= orderedViewIds.length,
    onClick: () => {
      lastTabOrderMoveKey = moveKey;
      commitSetting(setting, moveViewId(orderedViewIds, viewId, targetIndex));
    },
  });
  if (moveKey === lastTabOrderMoveKey) moveButton.dataset.restoresFocus = 'true';
  return moveButton;
}

function renderControl(setting: SettingsSetting) {
  if (setting.control === 'readonly') return renderReadout(setting);
  if (setting.control === 'toggle') return renderToggle(setting);
  if (setting.control === 'number') return renderNumber(setting);
  if (setting.control === 'select') return choicePresentation(setting) === 'segmented' ? renderSegmented(setting) : renderSelect(setting);
  if (setting.control === 'list') return renderList(setting);
  if (setting.control === 'shortcut-key') return renderShortcutKey(setting);
  if (setting.control === 'tab-order') return renderTabOrder(setting);
  return renderInput(setting);
}

export { isTextField, renderControl };
