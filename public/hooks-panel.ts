import './hooks-panel.css';
import { sendControlRequest } from './control-ws.ts';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from './action-status.ts';
import { NOT_CONNECTED_TEXT } from './updates-view-core.ts';
import { buildPanelSection, buildStatChip, el, isPanelHidden, projectsOf } from './dom-helpers.ts';
import { textArea, textInput } from './ui/text-input.ts';
import { openConfirmDialog } from './session-card/modal.ts';
import { button } from './ui/button.ts';
import { emptyState } from './ui/empty-state.ts';
import { checkbox, radio } from './ui/checkbox.ts';
import { createPressable } from './ui/pressable.ts';
import { select } from './ui/select.ts';
import { disclosure } from './ui/disclosure.ts';
import { createLineIcon, PLUS_ICON_PATH } from './svg-dom.ts';
import {
  ALL_PROJECTS_LABEL,
  BUILTIN_HINT,
  BUILTIN_TITLE,
  DEFAULT_TIMEOUT_TEXT,
  DISCARD_TEXT,
  DISCARD_TITLE,
  DUPLICATE_LABEL,
  EDITOR_HINT,
  EDIT_HOOK_TITLE,
  FILTER_EMPTY_TEXT,
  FILTER_PLACEHOLDER,
  HOOKS_APPLY_NOTE,
  HOOKS_EMPTY_TEXT,
  HOOKS_HINT,
  HOOKS_LOADING_TEXT,
  HOOK_TEMPLATES,
  HOOK_TYPE_OPTIONS,
  NEW_HOOK_TITLE,
  PREVIEW_HINT,
  PREVIEW_LABEL,
  SHORTCUT_HINT,
  TEMPLATES_LABEL,
  YOUR_HOOKS_TITLE,
  AGENT_NOTES_HINT,
  AGENT_NOTES_TITLE,
  agentGroupTitle,
  agentNoteMeta,
  agentNotesOf,
  builtinCountOf,
  builtinGroupsOf,
  builtinLine,
  deleteConfirmText,
  draftProblem,
  duplicateName,
  emptyDraft,
  eventChipText,
  eventsOf,
  filterHooks,
  fromDraft,
  groupHooksByEvent,
  hooksErrorLine,
  hooksOf,
  isDraftDirty,
  isHooksUnavailable,
  matcherHint,
  maxTimeoutOf,
  missingProjectIds,
  scopeLabel,
  settingsEntryPreview,
  showsFilter,
  sortHooks,
  targetLine,
  templateDraft,
  timeoutLabel,
  toDraft,
  toggledHook,
  totalsChips,
  typeLabel,
} from './hooks-view-core.ts';
import type { AgentHookGroup, AgentNote, InstalledHookRow } from '#shared/contracts/hooks.ts';
import type { HookDraft, HookEvent, HookProject, HookRecord } from './hooks-view-core.ts';
import { hooksSnapshot, requestHooksReport, subscribeHooks } from './hooks-store.ts';
import type { ViewRefreshReason } from './view-registry-core.ts';

let _hooks = hooksSnapshot();
let _root: HTMLDivElement | null = null;
let _draft: HookDraft | null = null;

let _draftOrigin: Record<string, unknown> | null = null;
let _editorEl: HTMLElement | null = null;
let _editorStatus: ReturnType<typeof createActionStatus> | null = null;
let _editorSaveButton: HTMLButtonElement | null = null;
let _saving = false;
let _filter = '';

const _openPreviews = new Set<string>();

const _busyIds = new Set<string>();

type RowFeedback = { tone: 'busy' | 'error'; text: string };

const _rowFeedbackById = new Map<string, RowFeedback>();

let _focusAddOnRender = false;

const buildSection = (title: string | null | undefined, hint?: string | null) => buildPanelSection('hooks', title, hint);

function buildLine(className: string, text: string | null | undefined, tone?: string | null) {
  const line = el('p', className, text);
  if (tone) line.dataset.tone = tone;
  return line;
}

function buildRowButton(variant: 'secondary' | 'danger', label: string, action: string, ariaLabel: string, onClick: () => void) {
  const rowButton = button({ variant, size: 'small', label, action, onClick });
  rowButton.setAttribute('aria-label', ariaLabel);
  return rowButton;
}

async function requestHookChange(type: 'save-hook' | 'delete-hook', payload: Record<string, unknown>): Promise<string | null> {
  try {
    const reply = await sendControlRequest(type, payload, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if ((reply.type === 'save-hook-result' || reply.type === 'delete-hook-result') && reply.ok) return null;
    const fallbackText = type === 'save-hook' ? 'Could not save the hook.' : 'Could not delete the hook.';
    return 'error' in reply && typeof reply.error === 'string' && reply.error ? reply.error : fallbackText;
  } catch (reason) {
    return requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS);
  }
}

async function runRowRequest(hookId: string, type: 'save-hook' | 'delete-hook', payload: Record<string, unknown>, busyText: string) {
  _busyIds.add(hookId);
  _rowFeedbackById.set(hookId, { tone: 'busy', text: busyText });
  render({ force: true });
  const failureText = await requestHookChange(type, payload);
  _busyIds.delete(hookId);
  if (failureText) _rowFeedbackById.set(hookId, { tone: 'error', text: failureText });
  if (!failureText) _rowFeedbackById.delete(hookId);
  render({ force: true });
  requestHooksReport();
}

function buildField(label: string, control: HTMLElement, hint: string | null) {
  const field = el('label', 'hooks-field');
  field.append(el('span', 'hooks-field-label', label), control);
  if (hint) field.append(el('span', 'hooks-field-hint', hint));
  return field;
}

function buildInput(value: string, placeholder: string, onInput: (value: string) => void) {
  return textInput({ value, placeholder, onInput });
}

function buildTextarea(value: string, onInput: (value: string) => void) {
  const area = textArea({ value, spellcheck: false, onInput });
  area.classList.add('hooks-command');
  return area;
}

function eventDescription(events: HookEvent[], eventName: string): string {
  return events.find((entry) => entry.name === eventName)?.description ?? '';
}

function buildEventSelect(draft: HookDraft, events: HookEvent[], onChange: (value: string) => void) {
  return select({ options: events.map((entry) => ({ value: entry.name, label: entry.name })), value: draft.event, onChange }).element;
}

function buildTypeRow(draft: HookDraft, onChange: (value: string) => void) {
  const row = el('div', 'hooks-type-row');
  row.setAttribute('role', 'radiogroup');
  for (const option of HOOK_TYPE_OPTIONS) {
    row.append(radio({ name: 'hooks-type', value: option.value, label: option.label, checked: draft.type === option.value, onSelect: () => onChange(option.value) }).element);
  }
  return row;
}

function buildProjectPicker(draft: HookDraft, projects: HookProject[]) {
  const wrap = el('div', 'hooks-projects');
  if (projects.length === 0) {
    wrap.append(el('span', 'hooks-field-hint', ALL_PROJECTS_LABEL));
    return wrap;
  }
  const every = checkbox({ label: ALL_PROJECTS_LABEL, checked: draft.projects.length === 0 });
  const everyBox = every.input;
  wrap.append(every.element);
  const boxes: HTMLInputElement[] = [];
  for (const project of projects) {
    const choice = checkbox({
      label: projectChoiceLabel(project),
      value: project.id,
      checked: draft.projects.includes(project.id),
      onChange: () => {
        draft.projects = boxes.filter((entry) => entry.checked).map((entry) => entry.value);
        everyBox.checked = draft.projects.length === 0;
      },
    });
    boxes.push(choice.input);
    wrap.append(choice.element);
  }
  everyBox.addEventListener('change', () => {
    if (!everyBox.checked) { everyBox.checked = draft.projects.length === 0; return; }
    for (const box of boxes) box.checked = false;
    draft.projects = [];
  });
  return wrap;
}

function projectChoiceLabel(project: HookProject): string | Node {
  if (project.agent === 'claude-code') return project.name;
  const label = document.createDocumentFragment();
  label.append(el('span', null, project.name), el('span', 'hooks-choice-note', `${project.agent}, hook never runs`));
  return label;
}

function buildTemplateRow(events: HookEvent[]) {
  const row = el('div', 'hooks-templates');
  row.append(el('span', 'hooks-templates-label', TEMPLATES_LABEL));
  for (const template of HOOK_TEMPLATES) {
    const chip = createPressable('hooks-chip', template.label);
    chip.addEventListener('click', () => openEditor(null, templateDraft(template, events)));
    row.append(chip);
  }
  return row;
}

function setEditorError(text: string | null) {
  if (!_editorStatus) return;
  if (!text) { _editorStatus.clear(); return; }
  _editorStatus.show('error', text);
}

function buildEditor(draft: HookDraft) {
  const events = eventsOf(_hooks.report);
  const projects = projectsOf<HookProject>(_hooks.report);
  const section = buildSection(draft.id ? EDIT_HOOK_TITLE : NEW_HOOK_TITLE, EDITOR_HINT);
  section.classList.add('hooks-editor');
  const form = el('form', 'hooks-form');
  form.addEventListener('submit', (event) => { event.preventDefault(); submitEditor(); });
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); requestCloseEditor(); return; }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submitEditor(); }
  });
  if (!draft.id) form.append(buildTemplateRow(events));

  const matcherHintEl = el('span', 'hooks-field-hint', matcherHint(events, draft.event));
  const matcherInput = buildInput(draft.matcher, '', (value) => { draft.matcher = value; });
  const commandField = buildField('Command', buildTextarea(draft.command, (value) => { draft.command = value; }), 'Runs through the shell with the event JSON on stdin. Exit 2 blocks the action where the event allows it.');
  const urlField = buildField('URL', buildInput(draft.url, 'http://127.0.0.1:8080/hook', (value) => { draft.url = value; }), 'Claude Code POSTs the event JSON to it.');
  const syncType = () => {
    commandField.hidden = draft.type !== 'command';
    urlField.hidden = draft.type !== 'http';
  };
  syncType();

  const matcherField = buildField('Matcher', matcherInput, null);
  matcherField.append(matcherHintEl);
  const syncMatcher = () => {
    const entry = events.find((candidate) => candidate.name === draft.event);
    matcherHintEl.textContent = matcherHint(events, draft.event);
    matcherInput.disabled = !!entry && !entry.matcher;
    if (matcherInput.disabled) { matcherInput.value = ''; draft.matcher = ''; }
  };
  syncMatcher();

  const timeoutInput = textInput({ type: 'number', value: draft.timeout, onInput: (value) => { draft.timeout = value; } });
  timeoutInput.classList.add('hooks-timeout');
  timeoutInput.inputMode = 'numeric';
  timeoutInput.min = '1';
  timeoutInput.max = String(maxTimeoutOf(_hooks.report));

  const eventHint = el('span', 'hooks-field-hint', eventDescription(events, draft.event));
  const eventField = buildField('Event', buildEventSelect(draft, events, (value) => { draft.event = value; eventHint.textContent = eventDescription(events, value); syncMatcher(); }), null);
  eventField.append(eventHint);

  const enabledLabel = checkbox({ label: 'Enabled', checked: draft.enabled, onChange: (checked) => { draft.enabled = checked; } }).element;

  form.append(
    buildField('Name', buildInput(draft.name, 'Lint after edits', (value) => { draft.name = value; }), null),
    eventField,
    matcherField,
    buildField('Type', buildTypeRow(draft, (value) => { draft.type = value; syncType(); }), HOOK_TYPE_OPTIONS.map((option) => `${option.label}: ${option.hint}`).join(' ')),
    commandField,
    urlField,
    buildField('Timeout (seconds)', timeoutInput, DEFAULT_TIMEOUT_TEXT),
    buildField('Projects', buildProjectPicker(draft, projects), null),
    buildField('', enabledLabel, null),
  );

  _editorStatus = createActionStatus('hooks-editor-status');
  const footer = el('div', 'hooks-editor-footer');
  const shortcut = el('span', 'hooks-editor-shortcut', SHORTCUT_HINT);
  const cancel = button({ variant: 'secondary', label: 'Cancel', action: 'cancel-hook-edit', onClick: requestCloseEditor });
  const save = button({ variant: 'primary', label: draft.id ? 'Save changes' : 'Add hook', action: 'save-hook' });
  save.type = 'submit';
  _editorSaveButton = save;
  footer.append(_editorStatus.element, shortcut, cancel, save);
  form.append(footer);
  section.append(form);
  return section;
}

function openEditor(hook: HookRecord | null, draft: HookDraft | null = null) {
  _draft = draft || (hook ? toDraft(hook) : emptyDraft(eventsOf(_hooks.report)));

  _draftOrigin = fromDraft(hook ? toDraft(hook) : emptyDraft(eventsOf(_hooks.report)));
  _editorEl = buildEditor(_draft);
  render({ force: true });
  _editorEl.scrollIntoView({ block: 'nearest' });
  const first = _editorEl.querySelector('input[type=text]');
  if (first instanceof HTMLInputElement) first.focus();
}

function closeEditor() {
  _draft = null;
  _draftOrigin = null;
  _editorEl = null;
  _editorStatus = null;
  _editorSaveButton = null;
  _saving = false;
  _focusAddOnRender = true;
  render({ force: true });
}

function requestCloseEditor() {
  if (!_draft || !_draftOrigin || !isDraftDirty(_draft, _draftOrigin)) { closeEditor(); return; }
  openConfirmDialog({ title: DISCARD_TITLE, message: DISCARD_TEXT, confirmLabel: 'Discard', danger: true, onConfirm: closeEditor });
}

async function submitEditor() {
  if (!_draft || _saving) return;
  const problem = draftProblem(_draft, eventsOf(_hooks.report), maxTimeoutOf(_hooks.report));
  if (problem) { setEditorError(problem); return; }
  const savingStatus = _editorStatus;
  const saveButton = _editorSaveButton;
  _saving = true;
  savingStatus?.show('busy', 'Saving the hook.');
  if (saveButton) saveButton.disabled = true;
  const failureText = await requestHookChange('save-hook', { hook: fromDraft(_draft) });
  _saving = false;
  if (saveButton) saveButton.disabled = false;
  if (savingStatus !== _editorStatus) return;
  if (failureText) { setEditorError(failureText); return; }
  closeEditor();
  requestHooksReport();
}

function buildPreview(hook: HookRecord) {
  const preview = disclosure({
    summary: PREVIEW_LABEL,
    body: [el('p', 'hooks-field-hint', PREVIEW_HINT), el('pre', 'hooks-preview-code', settingsEntryPreview(hook))],
    open: _openPreviews.has(hook.id),
    onToggle: (isOpen) => {
      if (isOpen) { _openPreviews.add(hook.id); return; }
      _openPreviews.delete(hook.id);
    },
  });
  preview.element.classList.add('hooks-preview');
  preview.summary.classList.add('hooks-preview-summary');
  return preview.element;
}

function buildRow(hook: HookRecord, { grouped = false }: { grouped?: boolean } = {}) {
  const projects = projectsOf<HookProject>(_hooks.report);
  const row = el('article', 'hooks-row');
  row.setAttribute('aria-label', hook.name);
  if (hook.enabled === false) row.dataset.state = 'off';
  const main = el('div', 'hooks-row-main');
  const head = el('div', 'hooks-row-head');

  head.append(el('span', 'hooks-row-name', hook.name));
  const chipText = grouped ? (hook.matcher || '') : eventChipText(hook);
  if (chipText) head.append(el('span', 'hooks-row-event', chipText));
  const target = el('code', 'hooks-row-target', targetLine(hook));
  const meta = el('p', 'hooks-row-meta', [typeLabel(hook.type), timeoutLabel(hook), scopeLabel(hook, projects)].filter(Boolean).join(' / '));
  main.append(head, target, meta);
  const missing = missingProjectIds(hook, projects);
  if (missing.length > 0) main.append(buildLine('hooks-row-meta', `Scoped to a project no longer in config: ${missing.join(', ')}`, 'warn'));
  main.append(buildPreview(hook));
  const feedback = _rowFeedbackById.get(hook.id);
  if (feedback) {
    const rowStatus = createActionStatus('hooks-row-status');
    rowStatus.show(feedback.tone, feedback.text);
    main.append(rowStatus.element);
  }

  const actions = el('div', 'hooks-row-actions');
  const toggleLabel = checkbox({
    label: 'On',
    checked: hook.enabled !== false,
    disabled: _busyIds.has(hook.id),
    accessibleName: `${hook.name} enabled`,
    onChange: (checked) => {
      void runRowRequest(hook.id, 'save-hook', { hook: toggledHook(hook) }, checked ? 'Turning the hook on.' : 'Turning the hook off.');
    },
  }).element;
  const edit = buildRowButton('secondary', 'Edit', 'edit-hook', `Edit ${hook.name}`, () => openEditor(hook));
  const duplicate = buildRowButton('secondary', DUPLICATE_LABEL, 'duplicate-hook', `Duplicate ${hook.name}`, () => {
    const copy = toDraft({ ...hook, name: duplicateName(hook.name) });
    copy.id = null;
    openEditor(null, copy);
  });
  const remove = buildRowButton('danger', 'Delete', 'delete-hook', `Delete ${hook.name}`, () => {
    openConfirmDialog({
      title: 'Delete hook',
      message: deleteConfirmText(hook),
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        void runRowRequest(hook.id, 'delete-hook', { id: hook.id }, 'Deleting the hook.');
      },
    });
  });
  remove.disabled = _busyIds.has(hook.id);
  actions.append(toggleLabel, edit, duplicate, remove);
  row.append(main, actions);
  return row;
}

function buildBuiltinRow(entry: InstalledHookRow) {
  const row = el('article', 'hooks-row hooks-row-builtin');
  const main = el('div', 'hooks-row-main');
  main.append(el('span', 'hooks-row-event', builtinLine(entry)), el('p', 'hooks-row-meta', entry.purpose));
  row.append(main);
  return row;
}

function buildTotalsSection() {
  const section = buildSection('Hooks', HOOKS_HINT);
  const chips = el('div', 'hooks-stats');
  for (const chip of totalsChips(_hooks.report)) chips.append(buildStatChip('hooks', chip.label, chip.value, chip.tone));
  section.append(chips, buildLine('hooks-meta', HOOKS_APPLY_NOTE));
  return section;
}

function buildFilter() {
  const input = textInput({ type: 'search', size: 'compact', value: _filter, placeholder: FILTER_PLACEHOLDER, label: FILTER_PLACEHOLDER, onInput: (value) => {
    _filter = value;
    const list = _root?.querySelector('.hooks-list-yours');
    if (list) list.replaceWith(buildYoursList());
  } });
  input.classList.add('hooks-filter');
  return input;
}

function buildEmptyState() {
  return emptyState({ text: HOOKS_EMPTY_TEXT, actions: [buildTemplateRow(eventsOf(_hooks.report))], variant: 'boxed' });
}

function buildYoursList() {
  const wrap = el('div', 'hooks-list-yours');
  const hooks = hooksOf(_hooks.report);
  if (hooks.length === 0) {
    wrap.append(buildEmptyState());
    return wrap;
  }
  const shown = filterHooks(sortHooks(hooks, eventsOf(_hooks.report)), _filter);
  if (shown.length === 0) {
    wrap.append(emptyState({ text: FILTER_EMPTY_TEXT }));
    return wrap;
  }
  for (const group of groupHooksByEvent(shown)) {
    const groupEl = el('div', 'hooks-group');
    groupEl.append(el('h3', 'hooks-group-title', group.event));
    const list = el('div', 'hooks-list');
    for (const hook of group.hooks) list.append(buildRow(hook, { grouped: true }));
    groupEl.append(list);
    wrap.append(groupEl);
  }
  return wrap;
}

function buildYoursSection() {
  const section = buildSection(YOUR_HOOKS_TITLE, null);
  const add = button({ variant: 'primary', size: 'small', label: NEW_HOOK_TITLE, icon: createLineIcon(PLUS_ICON_PATH), action: 'new-hook', disabled: !!_draft, onClick: () => openEditor(null) });
  const head = section.querySelector('.hooks-section-head');
  if (head) head.append(add);
  if (showsFilter(hooksOf(_hooks.report))) section.append(buildFilter());
  section.append(buildYoursList());
  return section;
}

function buildAgentGroup(group: AgentHookGroup) {
  const list = el('div', 'hooks-list');
  if (group.unavailableReason !== null) list.append(el('p', 'hooks-row-meta', group.unavailableReason));
  for (const entry of group.rows) list.append(buildBuiltinRow(entry));
  const agentGroup = disclosure({ summary: agentGroupTitle(group), body: list });
  agentGroup.summary.classList.add('hooks-agent-group-summary');
  return agentGroup.element;
}

function buildBuiltinDisclosure(title: string, hint: string, content: HTMLElement) {
  const section = disclosure({ summary: [el('span', 'hooks-section-title', title), el('span', 'hooks-section-hint', hint)], body: content });
  section.element.classList.add('hooks-builtin');
  section.summary.classList.add('hooks-builtin-summary');
  return section.element;
}

function buildBuiltinSection() {
  const groups = el('div', 'hooks-agent-groups');
  for (const group of builtinGroupsOf(_hooks.report)) groups.append(buildAgentGroup(group));
  return buildBuiltinDisclosure(`${BUILTIN_TITLE} (${builtinCountOf(_hooks.report)})`, BUILTIN_HINT, groups);
}

function buildAgentNoteRow(note: AgentNote) {
  const row = el('article', 'hooks-row hooks-row-builtin');
  const main = el('div', 'hooks-row-main');
  main.append(el('span', 'hooks-row-event', note.name), el('p', 'hooks-row-meta', agentNoteMeta(note)), el('code', 'hooks-note-text', note.text));
  row.append(main);
  return row;
}

function buildAgentNotesSection() {
  const notes = agentNotesOf(_hooks.report);
  const list = el('div', 'hooks-list');
  for (const note of notes) list.append(buildAgentNoteRow(note));
  return buildBuiltinDisclosure(`${AGENT_NOTES_TITLE} (${notes.length})`, AGENT_NOTES_HINT, list);
}

function buildBody() {
  const content = el('div', 'hooks-content');
  if (!_hooks.report) {
    content.append(_hooks.hasReportSendFailed ? buildLine('hooks-warning', NOT_CONNECTED_TEXT) : buildLine('hooks-empty', HOOKS_LOADING_TEXT));
    return content;
  }
  if (isHooksUnavailable(_hooks.report)) {
    content.append(buildLine('hooks-warning', hooksErrorLine(_hooks.report)));
    return content;
  }
  content.append(buildTotalsSection());
  if (_editorEl) content.append(_editorEl);
  content.append(buildYoursSection(), buildBuiltinSection(), buildAgentNotesSection());
  return content;
}

function render({ force = false }: { force?: boolean } = {}) {
  if (!_root) return;
  if (!force && isPanelHidden(_root)) return;
  _hooks = hooksSnapshot();
  _root.replaceChildren(buildBody());
  if (!_focusAddOnRender) return;
  _focusAddOnRender = false;
  const add = _root.querySelector('[data-action="new-hook"]');
  if (add instanceof HTMLButtonElement) add.focus();
}

subscribeHooks(() => render());

export function renderHooksPage(container: HTMLElement) {
  _root = el('div', 'hooks-panel');
  container.append(_root);
  render({ force: true });
  requestHooksReport();
}

export function refreshHooksPage(reason: ViewRefreshReason) {
  if (reason === 'shown') render({ force: true });
  requestHooksReport();
}
