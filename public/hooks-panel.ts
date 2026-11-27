import './hooks-panel.css';
import { createActionStatus } from './action-status.ts';
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
import { field } from './ui/field.ts';
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
import deleteHookAction from './state/actions/delete-hook.ts';
import saveHookAction from './state/actions/save-hook.ts';
import {
  hooksSnapshot,
  onHooksChanged,
  requestHooksReport,
} from './state/collections/hooks.ts';
import { isOptimisticHookId } from './state/hooks-core.ts';
import { placeRowsInOrder } from './status-paint.ts';
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
let _collectionRevision = 0;
let _renderedRevision = -1;

interface MountedHookRow {
  element: HTMLElement;
  fingerprint: string;
}

interface MountedHookGroup {
  element: HTMLElement;
  list: HTMLElement;
}

interface MountedHooksShell {
  content: HTMLElement;
  totalsSection: HTMLElement;
  yoursSection: HTMLElement;
  addButton: HTMLButtonElement;
  filterInput: HTMLInputElement | null;
  yoursListWrap: HTMLElement;
  builtinSection: HTMLElement;
  notesSection: HTMLElement;
  totalsFingerprint: string;
  builtinFingerprint: string;
  notesFingerprint: string;
  emptyMode: 'none' | 'empty' | 'filter-empty';
  rowByHookId: Map<string, MountedHookRow>;
  groupByEvent: Map<string, MountedHookGroup>;
}

let _shell: MountedHooksShell | null = null;
let _statusKey: string | null = null;

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

async function saveHookRecord(hook: Record<string, unknown>): Promise<string | null> {
  const saveOutcome = await saveHookAction({ hook });
  if (!saveOutcome.ok) return saveOutcome.error.message;
  return null;
}

async function deleteHookRecord(hook: Pick<HookRecord, 'id' | 'name'>): Promise<string | null> {
  const deleteOutcome = await deleteHookAction({ id: hook.id, name: hook.name });
  if (!deleteOutcome.ok) return deleteOutcome.error.message;
  return null;
}

async function runRowRequest(hookId: string, perform: () => Promise<string | null>, busyText: string) {
  _busyIds.add(hookId);
  _rowFeedbackById.set(hookId, { tone: 'busy', text: busyText });
  render({ force: true });
  const failureText = await perform();
  _busyIds.delete(hookId);
  if (failureText) _rowFeedbackById.set(hookId, { tone: 'error', text: failureText });
  if (!failureText) _rowFeedbackById.delete(hookId);
  render({ force: true });
  requestHooksReport({ force: true });
}

function buildField(label: string, control: HTMLElement, hint = '') {
  return field({ label, control, hint, layout: 'grid' });
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

  const matcherInput = buildInput(draft.matcher, '', (value) => { draft.matcher = value; });
  const commandField = buildField('Command', buildTextarea(draft.command, (value) => { draft.command = value; }), 'Runs through the shell with the event JSON on stdin. Exit 2 blocks the action where the event allows it.').element;
  const urlField = buildField('URL', buildInput(draft.url, 'http://127.0.0.1:8080/hook', (value) => { draft.url = value; }), 'Claude Code POSTs the event JSON to it.').element;
  const syncType = () => {
    commandField.hidden = draft.type !== 'command';
    urlField.hidden = draft.type !== 'http';
  };
  syncType();

  const matcherField = buildField('Matcher', matcherInput);
  const syncMatcher = () => {
    const entry = events.find((candidate) => candidate.name === draft.event);
    matcherField.setHint(matcherHint(events, draft.event));
    matcherInput.disabled = !!entry && !entry.matcher;
    if (matcherInput.disabled) { matcherInput.value = ''; draft.matcher = ''; }
  };
  syncMatcher();

  const timeoutInput = textInput({ type: 'number', value: draft.timeout, onInput: (value) => { draft.timeout = value; } });
  timeoutInput.classList.add('hooks-timeout');
  timeoutInput.inputMode = 'numeric';
  timeoutInput.min = '1';
  timeoutInput.max = String(maxTimeoutOf(_hooks.report));

  const eventField = buildField('Event', buildEventSelect(draft, events, (value) => { draft.event = value; eventField.setHint(eventDescription(events, value)); syncMatcher(); }), eventDescription(events, draft.event));

  const enabledLabel = checkbox({ label: 'Enabled', checked: draft.enabled, onChange: (checked) => { draft.enabled = checked; } }).element;

  form.append(
    buildField('Name', buildInput(draft.name, 'Lint after edits', (value) => { draft.name = value; })).element,
    eventField.element,
    matcherField.element,
    buildField('Type', buildTypeRow(draft, (value) => { draft.type = value; syncType(); }), HOOK_TYPE_OPTIONS.map((option) => `${option.label}: ${option.hint}`).join(' ')).element,
    commandField,
    urlField,
    buildField('Timeout (seconds)', timeoutInput, DEFAULT_TIMEOUT_TEXT).element,
    buildField('Projects', buildProjectPicker(draft, projects)).element,
    buildField('', enabledLabel).element,
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
  const failureText = await saveHookRecord(fromDraft(_draft));
  _saving = false;
  if (saveButton) saveButton.disabled = false;
  if (savingStatus !== _editorStatus) return;
  if (failureText) { setEditorError(failureText); return; }
  closeEditor();
  requestHooksReport({ force: true });
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

  const isRowBusy = _busyIds.has(hook.id) || isOptimisticHookId(hook.id);
  const actions = el('div', 'hooks-row-actions');
  const toggleLabel = checkbox({
    label: 'On',
    checked: hook.enabled !== false,
    disabled: isRowBusy,
    accessibleName: `${hook.name} enabled`,
    onChange: (checked) => {
      void runRowRequest(hook.id, () => saveHookRecord(toggledHook(hook)), checked ? 'Turning the hook on.' : 'Turning the hook off.');
    },
  }).element;
  const edit = buildRowButton('secondary', 'Edit', 'edit-hook', `Edit ${hook.name}`, () => openEditor(hook));
  edit.disabled = isRowBusy;
  const duplicate = buildRowButton('secondary', DUPLICATE_LABEL, 'duplicate-hook', `Duplicate ${hook.name}`, () => {
    const copy = toDraft({ ...hook, name: duplicateName(hook.name) });
    copy.id = null;
    openEditor(null, copy);
  });
  duplicate.disabled = isRowBusy;
  const remove = buildRowButton('danger', 'Delete', 'delete-hook', `Delete ${hook.name}`, () => {
    openConfirmDialog({
      title: 'Delete hook',
      message: deleteConfirmText(hook),
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        void runRowRequest(hook.id, () => deleteHookRecord(hook), 'Deleting the hook.');
      },
    });
  });
  remove.disabled = isRowBusy;
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
  const input = textInput({ type: 'search', size: 'small', value: _filter, placeholder: FILTER_PLACEHOLDER, label: FILTER_PLACEHOLDER, onInput: (value) => {
    _filter = value;
    if (_shell) syncYoursList(_shell);
  } });
  input.classList.add('hooks-filter');
  return input;
}

function buildEmptyState() {
  return emptyState({ text: HOOKS_EMPTY_TEXT, actions: [buildTemplateRow(eventsOf(_hooks.report))], variant: 'boxed' });
}

function hookRowFingerprint(hook: HookRecord, projects: HookProject[]): string {
  return JSON.stringify({
    hook,
    scope: scopeLabel(hook, projects),
    missing: missingProjectIds(hook, projects),
    busy: _busyIds.has(hook.id) || isOptimisticHookId(hook.id),
    feedback: _rowFeedbackById.get(hook.id) ?? null,
  });
}

function syncYoursList(shell: MountedHooksShell) {
  const wrap = shell.yoursListWrap;
  const hooks = hooksOf(_hooks.report);
  if (hooks.length === 0) {
    shell.rowByHookId.clear();
    shell.groupByEvent.clear();
    if (shell.emptyMode !== 'empty') {
      wrap.replaceChildren(buildEmptyState());
      shell.emptyMode = 'empty';
    }
    return;
  }
  const shown = filterHooks(sortHooks(hooks, eventsOf(_hooks.report)), _filter);
  if (shown.length === 0) {
    shell.rowByHookId.clear();
    shell.groupByEvent.clear();
    if (shell.emptyMode !== 'filter-empty') {
      wrap.replaceChildren(emptyState({ text: FILTER_EMPTY_TEXT }));
      shell.emptyMode = 'filter-empty';
    }
    return;
  }
  if (shell.emptyMode !== 'none') {
    wrap.replaceChildren();
    shell.emptyMode = 'none';
  }
  const projects = projectsOf<HookProject>(_hooks.report);
  const groups = groupHooksByEvent(shown);
  const activeGroupKeys = new Set<string>();
  const seenEventCounts = new Map<string, number>();
  const activeHookIds = new Set<string>();
  const orderedGroupEls: HTMLElement[] = [];

  for (const group of groups) {
    const occurrence = seenEventCounts.get(group.event) ?? 0;
    seenEventCounts.set(group.event, occurrence + 1);
    const groupKey = occurrence === 0 ? group.event : `${group.event}#${occurrence}`;
    activeGroupKeys.add(groupKey);
    let mountedGroup = shell.groupByEvent.get(groupKey);
    if (!mountedGroup) {
      const groupEl = el('div', 'hooks-group');
      groupEl.append(el('h3', 'hooks-group-title', group.event));
      const list = el('div', 'hooks-list');
      groupEl.append(list);
      mountedGroup = { element: groupEl, list };
      shell.groupByEvent.set(groupKey, mountedGroup);
    }
    const orderedRowEls: HTMLElement[] = [];
    const activeRowSet = new Set<HTMLElement>();
    for (const hook of group.hooks) {
      activeHookIds.add(hook.id);
      const nextFingerprint = hookRowFingerprint(hook, projects);
      const existing = shell.rowByHookId.get(hook.id);
      if (existing && existing.fingerprint === nextFingerprint) {
        orderedRowEls.push(existing.element);
        activeRowSet.add(existing.element);
        continue;
      }
      const nextRowEl = buildRow(hook, { grouped: true });
      if (existing && existing.element.parentElement === mountedGroup.list) {
        existing.element.replaceWith(nextRowEl);
      }
      shell.rowByHookId.set(hook.id, { element: nextRowEl, fingerprint: nextFingerprint });
      orderedRowEls.push(nextRowEl);
      activeRowSet.add(nextRowEl);
    }
    for (const child of Array.from(mountedGroup.list.children)) {
      if (child instanceof HTMLElement && !activeRowSet.has(child)) child.remove();
    }
    placeRowsInOrder(mountedGroup.list, orderedRowEls);
    orderedGroupEls.push(mountedGroup.element);
  }

  for (const [groupKey, mountedGroup] of shell.groupByEvent) {
    if (activeGroupKeys.has(groupKey)) continue;
    mountedGroup.element.remove();
    shell.groupByEvent.delete(groupKey);
  }
  for (const hookId of [...shell.rowByHookId.keys()]) {
    if (!activeHookIds.has(hookId)) shell.rowByHookId.delete(hookId);
  }
  placeRowsInOrder(wrap, orderedGroupEls);
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

function buildMountedShell(): MountedHooksShell {
  const content = el('div', 'hooks-content');
  const totalsSection = buildTotalsSection();
  const yoursSection = buildSection(YOUR_HOOKS_TITLE, null);
  const addButton = button({ variant: 'primary', size: 'small', label: NEW_HOOK_TITLE, icon: createLineIcon(PLUS_ICON_PATH), action: 'new-hook', disabled: !!_draft, onClick: () => openEditor(null) });
  const head = yoursSection.querySelector('.hooks-section-head');
  if (head) head.append(addButton);
  const yoursListWrap = el('div', 'hooks-list-yours');
  yoursSection.append(yoursListWrap);
  const builtinSection = buildBuiltinSection();
  const notesSection = buildAgentNotesSection();
  content.append(totalsSection);
  if (_editorEl) content.append(_editorEl);
  content.append(yoursSection, builtinSection, notesSection);
  return {
    content,
    totalsSection,
    yoursSection,
    addButton,
    filterInput: null,
    yoursListWrap,
    builtinSection,
    notesSection,
    totalsFingerprint: JSON.stringify(totalsChips(_hooks.report)),
    builtinFingerprint: JSON.stringify(builtinGroupsOf(_hooks.report)),
    notesFingerprint: JSON.stringify(agentNotesOf(_hooks.report)),
    emptyMode: 'none',
    rowByHookId: new Map(),
    groupByEvent: new Map(),
  };
}

function syncEditorSlot(shell: MountedHooksShell) {
  const existingEditor = shell.content.querySelector('.hooks-editor');
  if (_editorEl && existingEditor === _editorEl) return;
  if (existingEditor && existingEditor !== _editorEl) existingEditor.remove();
  if (_editorEl) shell.totalsSection.after(_editorEl);
}

function syncFilterControl(shell: MountedHooksShell) {
  const needsFilter = showsFilter(hooksOf(_hooks.report));
  if (needsFilter && !shell.filterInput) {
    shell.filterInput = buildFilter();
    shell.yoursListWrap.before(shell.filterInput);
    return;
  }
  if (!needsFilter && shell.filterInput) {
    shell.filterInput.remove();
    shell.filterInput = null;
  }
}

function syncMountedShell(shell: MountedHooksShell) {
  const nextTotalsFingerprint = JSON.stringify(totalsChips(_hooks.report));
  if (nextTotalsFingerprint !== shell.totalsFingerprint) {
    const nextTotals = buildTotalsSection();
    shell.totalsSection.replaceWith(nextTotals);
    shell.totalsSection = nextTotals;
    shell.totalsFingerprint = nextTotalsFingerprint;
  }
  syncEditorSlot(shell);
  shell.addButton.disabled = !!_draft;
  syncFilterControl(shell);
  syncYoursList(shell);

  const nextBuiltinFingerprint = JSON.stringify(builtinGroupsOf(_hooks.report));
  if (nextBuiltinFingerprint !== shell.builtinFingerprint) {
    const wasOpen = shell.builtinSection instanceof HTMLDetailsElement && shell.builtinSection.open;
    const nextBuiltin = buildBuiltinSection();
    if (nextBuiltin instanceof HTMLDetailsElement) nextBuiltin.open = wasOpen;
    shell.builtinSection.replaceWith(nextBuiltin);
    shell.builtinSection = nextBuiltin;
    shell.builtinFingerprint = nextBuiltinFingerprint;
  }

  const nextNotesFingerprint = JSON.stringify(agentNotesOf(_hooks.report));
  if (nextNotesFingerprint !== shell.notesFingerprint) {
    const wasOpen = shell.notesSection instanceof HTMLDetailsElement && shell.notesSection.open;
    const nextNotes = buildAgentNotesSection();
    if (nextNotes instanceof HTMLDetailsElement) nextNotes.open = wasOpen;
    shell.notesSection.replaceWith(nextNotes);
    shell.notesSection = nextNotes;
    shell.notesFingerprint = nextNotesFingerprint;
  }
}

function renderStatusContent(className: string, text: string) {
  if (!_root) return;
  const nextKey = `${className}:${text}`;
  if (_shell === null && _statusKey === nextKey && _root.firstElementChild) return;
  _shell = null;
  _statusKey = nextKey;
  const content = el('div', 'hooks-content');
  content.append(buildLine(className, text));
  _root.replaceChildren(content);
}

function render({ force = false }: { force?: boolean } = {}) {
  if (!_root) return;
  if (!force && isPanelHidden(_root)) return;
  _renderedRevision = _collectionRevision;
  _hooks = hooksSnapshot();
  if (!_hooks.report) {
    renderStatusContent(
      _hooks.hasReportSendFailed ? 'hooks-warning' : 'hooks-empty',
      _hooks.hasReportSendFailed ? NOT_CONNECTED_TEXT : HOOKS_LOADING_TEXT,
    );
    return;
  }
  if (isHooksUnavailable(_hooks.report)) {
    renderStatusContent('hooks-warning', hooksErrorLine(_hooks.report));
    return;
  }
  _statusKey = null;
  if (!_shell || !_shell.content.isConnected) {
    _shell = buildMountedShell();
    _root.replaceChildren(_shell.content);
  }
  syncMountedShell(_shell);
  if (!_focusAddOnRender) return;
  _focusAddOnRender = false;
  _shell.addButton.focus();
}

onHooksChanged(() => {
  _collectionRevision += 1;
  render();
});

export function renderHooksPage(container: HTMLElement) {
  _shell = null;
  _statusKey = null;
  _renderedRevision = -1;
  _root = el('div', 'hooks-panel');
  container.append(_root);
  render({ force: true });
  requestHooksReport();
}

export function refreshHooksPage(reason: ViewRefreshReason) {
  if (reason === 'shown') {
    if (_renderedRevision !== _collectionRevision) render();
    requestHooksReport({ force: false });
    return;
  }
  requestHooksReport({ force: true });
}
