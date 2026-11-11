import type { Board, Box, BoxLine, BoxMedia, Dial, DialValue, Element as BoardElement, Frame, LinkStateOfBox, Op, Step, Wire } from '#shared/contracts/whiteboard.ts';
import { DEVICE_FITS, DEVICE_NAMES, PLACED_DEVICE } from '#shared/whiteboard-devices.ts';
import { PLACED_ICON } from '#shared/whiteboard-icons.ts';
import { AnchorRef, BOX_CHANGES, LINE_STYLES, MediaLink, BOX_SHAPES, dialValuesOfBox, mediaOfBox, STEP_STATUSES, STICKY_TONES, WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import { isStackedPanel } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout } from '#shared/whiteboard-layout-core.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { refsOfElement } from '#shared/whiteboard-anchor-core.ts';
import { iconPicker } from './board-icon-picker.ts';

type DeviceBox = Extract<Box, { shape: 'device' }>;
type LegendEntry = Board['legend'][number];
type Choice = { value: string; text: string };
type FieldCommit = (fields: Record<string, unknown>) => void;
type LatestItems<Item> = () => readonly Item[] | null;

interface BoardInspectorOptions {
  container: HTMLElement;
  currentBoard: () => Board | null;
  layout: () => BoardLayout | null;
  sendOps: (ops: Op[]) => Promise<boolean>;
  codeSessionChoices: () => readonly Choice[];
  openRef: (ref: string) => void;
  worthALookReasonOf: (ref: string) => string | null;
  linkStateOf: (boxId: string) => LinkStateOfBox | null;
  addNoteOn: (boxId: string) => void;
  frameSelectedBoxes: () => void;
  stackSelectedBoxes: () => void;
  removeSelected: () => void;
}

type ReviewRowOptions = Pick<BoardInspectorOptions, 'openRef' | 'worthALookReasonOf'>;

interface SelectionActions {
  addNoteOn: (boxId: string) => void;
  frameSelectedBoxes: () => void;
  stackSelectedBoxes: () => void;
  removeSelected: () => void;
}

const MAX_LEGEND_ENTRIES = 12;
const MAX_WIRE_LABEL = 40;
const MAX_LINE_KEY = 40;
const MAX_CAPTION = 400;
const MAX_REF = 200;
const MAX_REFS = 8;
const NEW_REF = 'README.md';
const TONES: readonly Wire['tone'][] = ['plain', 'fail', 'join'];
const LINE_STYLE_CHOICES = choicesOf(LINE_STYLES);
const TONE_CHOICES = choicesOf(TONES);
const SHAPE_CHOICES = choicesOf(BOX_SHAPES);
const HEADING_BY_SHAPE: Readonly<Record<Box['shape'], string>> = { box: 'Box', decision: 'Decision', panel: 'Panel', icon: 'Icon', device: 'Device', sticky: 'Sticky', note: 'Note', text: 'Text' };
const DEVICE_CHOICES = choicesOf(DEVICE_NAMES);
const FIT_CHOICES = choicesOf(DEVICE_FITS);
const STICKY_TONE_CHOICES = choicesOf(STICKY_TONES);
const CHANGE_CHOICES = choicesOf(BOX_CHANGES);
const STEP_STATUS_CHOICES = choicesOf(STEP_STATUSES);
const SIDE_CHOICES: readonly Choice[] = [{ value: '', text: 'Auto' }, ...choicesOf(['left', 'right', 'top', 'bottom'])];
const PLANNED_STEP: Step = { status: 'planned' };

function choicesOf(values: readonly string[]): Choice[] {
  return values.map((value) => ({ value, text: value }));
}

function heading(text: string): HTMLElement {
  return el('h3', 'wb-inspect-heading', text);
}

function fieldRow(label: string, control: HTMLElement): HTMLElement {
  const row = el('label', 'wb-inspect-field');
  row.append(el('span', 'wb-inspect-label', label), control);
  return row;
}

function controlRow(label: string, control: HTMLElement): HTMLElement {
  const row = el('div', 'wb-inspect-field');
  row.append(el('span', 'wb-inspect-label', label), control);
  return row;
}

function textField(field: string, value: string, maxLength: number, commit: (value: string) => void, accessibleName?: string): HTMLInputElement {
  const input = el('input', 'wb-inspect-input');
  input.type = 'text';
  input.value = value;
  input.maxLength = maxLength;
  input.dataset.field = field;
  if (accessibleName) input.setAttribute('aria-label', accessibleName);
  input.addEventListener('change', () => commit(input.value));
  return input;
}

function selectField(field: string, choices: readonly Choice[], value: string, commit: (value: string) => void, accessibleName?: string): HTMLSelectElement {
  const select = el('select', 'wb-inspect-select');
  select.dataset.field = field;
  if (accessibleName) select.setAttribute('aria-label', accessibleName);
  select.append(...choices.map((choice) => {
    const option = el('option', null, choice.text);
    option.value = choice.value;
    option.selected = choice.value === value;
    return option;
  }));
  select.addEventListener('change', () => commit(select.value));
  return select;
}

function checkboxField(field: string, label: string, checked: boolean, commit: (checked: boolean) => void): HTMLElement {
  const input = el('input', 'wb-inspect-check');
  input.type = 'checkbox';
  input.checked = checked;
  input.dataset.field = field;
  input.addEventListener('change', () => commit(input.checked));
  const row = el('label', 'wb-inspect-toggle');
  row.append(input, el('span', null, label));
  return row;
}

function actionButton(field: string, label: string, onClick: () => void, accessibleName?: string): HTMLButtonElement {
  const inspectButton = button({ variant: 'quiet', size: 'small', label, action: label.toLowerCase().replaceAll(' ', '-'), onClick });
  inspectButton.dataset.field = field;
  if (accessibleName) inspectButton.setAttribute('aria-label', accessibleName);
  return inspectButton;
}

function listSection(title: string, rows: HTMLElement[], addButton: HTMLButtonElement): HTMLElement {
  const section = el('div', 'wb-inspect-list');
  section.append(el('span', 'wb-inspect-label', title), ...rows, addButton);
  return section;
}

function listEditing<Item>(latestItems: LatestItems<Item>, commitItems: (items: Item[]) => void) {
  return {
    edit(changedIndex: number, change: (item: Item) => Item): void {
      const items = latestItems();
      const item = items?.[changedIndex];
      if (!items || item === undefined) return;
      commitItems(items.map((existing, index) => (index === changedIndex ? change(item) : existing)));
    },
    remove(removedIndex: number): void {
      const items = latestItems();
      if (items) commitItems(items.filter((_, index) => index !== removedIndex));
    },
    append(item: (items: readonly Item[]) => Item): void {
      const items = latestItems();
      if (items) commitItems([...items, item(items)]);
    },
  };
}

function validRefOf(text: string): string | null {
  const ref = text.trim();
  return AnchorRef.safeParse(ref).success ? ref : null;
}

function refsEditor(owner: string, refs: readonly string[], latestRefs: LatestItems<string>, commitRefs: (refs: string[]) => void): HTMLElement {
  const editing = listEditing(latestRefs, commitRefs);
  const rows = refs.map((ref, index) => {
    const row = el('div', 'wb-inspect-row');
    row.append(
      textField(`ref-${index}`, ref, MAX_REF, (text) => {
        const nextRef = validRefOf(text);
        if (nextRef) editing.edit(index, () => nextRef);
      }, `Ref ${index + 1}`),
      actionButton(`ref-${index}-remove`, 'Remove', () => editing.remove(index), `Remove ref ${ref}`),
    );
    return row;
  });
  const addRef = actionButton('ref-add', 'Add ref', () => editing.append(() => NEW_REF), `Add a ref to ${owner}`);
  addRef.disabled = refs.length >= MAX_REFS;
  return listSection('Refs', rows, addRef);
}

function linkedFileStatusText(media: BoxMedia, linkState: LinkStateOfBox | null): string {
  if (linkState) return linkState.text;
  return media.link ? 'In sync with the file' : 'Not linked: the card is a board copy';
}

function linkedFileSection(media: BoxMedia, linkState: LinkStateOfBox | null, latestMedia: () => BoxMedia | null, set: FieldCommit): HTMLElement {
  const pathInput = el('input', 'wb-inspect-input');
  pathInput.type = 'text';
  pathInput.value = media.link?.path ?? '';
  pathInput.maxLength = MediaLink.shape.path.maxLength ?? MAX_REF;
  pathInput.placeholder = 'docs/plan.md';
  pathInput.dataset.field = 'link-path';
  pathInput.setAttribute('aria-label', 'Linked file path, relative to the code session worktree');
  const status = el('p', 'wb-inspect-hint wb-inspect-link-status', linkedFileStatusText(media, linkState));
  status.dataset.linkState = linkState?.state ?? (media.link ? 'in-sync' : 'unlinked');
  status.setAttribute('role', 'status');
  const linkButton = actionButton('link-file', 'Link', () => {
    const linkPath = pathInput.value.trim();
    const current = latestMedia();
    if (!current) return;
    if (!linkPath) {
      status.textContent = 'Give the file path relative to the code session worktree.';
      return;
    }
    set({ media: { ...current, link: { path: linkPath, syncedHash: null } } });
  }, 'Link this card to the file');
  const unlinkButton = actionButton('unlink-file', 'Unlink', () => {
    const current = latestMedia();
    if (current?.link) set({ media: { ...current, link: null } });
  }, 'Unlink this card from its file');
  unlinkButton.disabled = !media.link;
  const buttons = el('div', 'wb-inspect-row');
  buttons.append(linkButton, unlinkButton);
  const section = el('div', 'wb-inspect-list');
  section.append(el('span', 'wb-inspect-label', 'Linked file'), pathInput, buttons, status);
  return section;
}

function lineWithStyle(line: BoxLine, style: BoxLine['style']): BoxLine {
  if (style === 'kv') return { ...line, style, key: line.key || 'key' };
  return { ...line, style };
}

function linesEditor(owner: string, lines: readonly BoxLine[], latestLines: LatestItems<BoxLine>, commitLines: (lines: BoxLine[]) => void): HTMLElement {
  const editing = listEditing(latestLines, commitLines);
  const rows = lines.map((line, index) => {
    const row = el('div', 'wb-inspect-row');
    const lineNumber = index + 1;
    row.append(selectField(`line-${index}-style`, LINE_STYLE_CHOICES, line.style, (style) => {
      const nextStyle = LINE_STYLES.find((known) => known === style);
      if (nextStyle) editing.edit(index, (latestLine) => lineWithStyle(latestLine, nextStyle));
    }, `Line ${lineNumber} style`));
    if (line.style === 'kv') {
      row.append(textField(`line-${index}-key`, line.key ?? '', MAX_LINE_KEY, (key) => {
        if (key.trim()) editing.edit(index, (latestLine) => ({ ...latestLine, key: key.trim() }));
      }, `Line ${lineNumber} key`));
    }
    row.append(
      textField(`line-${index}-text`, line.text, WHITEBOARD_LIMITS.line, (text) => editing.edit(index, (latestLine) => ({ ...latestLine, text })), `Line ${lineNumber} text`),
      actionButton(`line-${index}-remove`, 'Remove', () => editing.remove(index), `Remove line ${lineNumber}`),
    );
    return row;
  });
  const addLine = actionButton('line-add', 'Add line', () => editing.append(() => ({ text: 'new line', muted: false, style: 'text', key: null })), `Add a line to ${owner}`);
  addLine.disabled = lines.length >= WHITEBOARD_LIMITS.linesPerBox;
  return listSection('Lines', rows, addLine);
}

function linkableMediaOf(box: Box | null): BoxMedia | null {
  const media = box ? mediaOfBox(box) : null;
  return media?.kind === 'doc' || media?.kind === 'page' ? media : null;
}

function boxSections(box: Box, latest: () => BoardElement | undefined, layout: BoardLayout | null, linkState: LinkStateOfBox | null, set: FieldCommit): HTMLElement[] {
  const latestBox = () => {
    const element = latest();
    return element?.kind === 'box' ? element : null;
  };
  const latestLines = () => {
    const latestElement = latestBox();
    return latestElement && 'lines' in latestElement ? latestElement.lines ?? null : null;
  };
  const laidOutPlace = () => {
    const laidOut = layout?.elements.find((element) => element.id === box.id);
    if (!layout || laidOut?.kind !== 'box') return null;
    return { x: laidOut.x, y: laidOut.y - layout.pinnedOffsetY };
  };
  const placeLeavingStack = () => {
    const stacked = latestBox();
    const at = stacked && isStackedPanel(stacked) ? laidOutPlace() : null;
    return at ? { at } : {};
  };
  const commitShape = (shape: string) => {
    if (shape === 'decision' || shape === 'box') set({ shape, ...placeLeavingStack() });
    if (shape === 'panel') set({ shape });
    if (shape === 'icon') set({ shape, icon: latestBox()?.icon ?? PLACED_ICON, ...placeLeavingStack() });
    if (shape === 'device') set({ shape, device: PLACED_DEVICE, ...placeLeavingStack() });
    if (shape === 'sticky' || shape === 'text') set({ shape, ...placeLeavingStack() });
  };
  const commitIsStep = (isStep: boolean) => {
    if (isStep) {
      set({ step: PLANNED_STEP });
      return;
    }
    const stepBox = latestBox();
    const isInBuildOrderBand = stepBox !== null && stepBox.at === null;
    const at = isInBuildOrderBand ? laidOutPlace() : null;
    set({ step: null, ...(at ? { at } : {}) });
  };
  const commitChange = (change: string) => {
    if (change === 'relabeled') {
      set({ change, was: latestBox()?.was ?? box.title });
      return;
    }
    set({ change, was: null });
  };
  return [
    heading(HEADING_BY_SHAPE[box.shape]),
    fieldRow('Title', textField('title', box.title, WHITEBOARD_LIMITS.title, (title) => {
      if (title.trim()) set({ title: title.trim() });
    })),
    controlRow('Icon', iconPicker({ field: 'icon', icon: box.icon, isRequired: box.shape === 'icon', accessibleName: 'Box icon', commit: (icon) => set({ icon }) })),
    fieldRow('Shape', selectField('shape', SHAPE_CHOICES, box.shape, commitShape)),
    fieldRow('Change', selectField('change', CHANGE_CHOICES, box.change, commitChange)),
    ...(box.change === 'relabeled' ? [fieldRow('Was', textField('was', box.was ?? '', WHITEBOARD_LIMITS.title, (was) => {
      if (was.trim()) set({ was: was.trim() });
    }))] : []),
    ...(box.shape === 'device' ? deviceSections(box, set) : []),
    ...('borderless' in box ? [checkboxField('borderless', 'Borderless', box.borderless, (borderless) => set({ borderless }))] : []),
    ...(box.shape === 'sticky' ? [fieldRow('Tone', selectField('tone', STICKY_TONE_CHOICES, box.tone, (tone) => set({ tone })))] : []),
    ...dialSections(box, latestBox, set),
    ...linkedFileSections(box, linkState, () => linkableMediaOf(latestBox()), set),
    refsEditor('this box', box.refs, () => latestBox()?.refs ?? null, (refs) => set({ refs })),
    ...(box.shape === 'icon' || box.shape === 'device' ? [] : [linesEditor('this box', box.lines, latestLines, (lines) => set({ lines }))]),
    checkboxField('is-step', 'Plan step', box.step !== null, commitIsStep),
    ...(box.step ? stepSections(box.step, set) : []),
  ];
}

function dialControlOf(dial: Dial, value: DialValue, commit: (value: DialValue) => void): HTMLElement {
  const field = `dial-${dial.id}`;
  switch (dial.kind) {
    case 'toggle': return checkboxField(field, dial.label, value === true, commit);
    case 'choice': return fieldRow(dial.label, selectField(field, dial.options.map((option) => ({ value: option, text: option })), String(value), commit));
    case 'color': return fieldRow(dial.label, dialInput(field, 'color', String(value), (input) => commit(input.value)));
    case 'range': {
      const slider = dialInput(field, 'range', String(value), (input) => commit(Number(input.value)));
      slider.min = String(dial.min);
      slider.max = String(dial.max);
      slider.step = String(dial.step);
      slider.value = String(value);
      return fieldRow(dial.label, slider);
    }
  }
}

function dialInput(field: string, type: 'color' | 'range', value: string, commit: (input: HTMLInputElement) => void): HTMLInputElement {
  const input = el('input', 'wb-inspect-dial');
  input.type = type;
  input.value = value;
  input.dataset.field = field;
  input.addEventListener('change', () => commit(input));
  return input;
}

function dialSections(box: Box, latestBox: () => Box | null, set: FieldCommit): HTMLElement[] {
  const media = mediaOfBox(box);
  if (media?.kind !== 'page' || media.dials.length === 0) return [];
  const dialValues = dialValuesOfBox(box);
  const commitDial = (dialId: string, value: DialValue) => {
    const latest = latestBox();
    const latestParams = latest && latest.shape !== 'icon' ? latest.params : {};
    set({ params: { ...latestParams, [dialId]: value } });
  };
  return [
    heading('Dials'),
    ...media.dials.map((dial) => dialControlOf(dial, dialValues[dial.id] ?? dial.default, (value) => commitDial(dial.id, value))),
  ];
}

function deviceSections(box: DeviceBox, set: FieldCommit): HTMLElement[] {
  return [
    fieldRow('Device', selectField('device', DEVICE_CHOICES, box.device, (device) => set({ device }))),
    fieldRow('Fit', selectField('fit', FIT_CHOICES, box.fit, (fit) => set({ fit }))),
  ];
}

function wireSections(wire: Wire, set: FieldCommit): HTMLElement[] {
  return [
    heading('Wire'),
    fieldRow('Label', textField('label', wire.label ?? '', MAX_WIRE_LABEL, (label) => set({ label: label.trim() || null }))),
    fieldRow('Tone', selectField('tone', TONE_CHOICES, wire.tone, (tone) => set({ tone }))),
    checkboxField('dashed', 'Dashed', wire.dashed, (dashed) => set({ dashed })),
    fieldRow('Leaves from', selectField('fromSide', SIDE_CHOICES, wire.fromSide ?? '', (side) => set({ fromSide: side || null }))),
    fieldRow('Arrives at', selectField('toSide', SIDE_CHOICES, wire.toSide ?? '', (side) => set({ toSide: side || null }))),
  ];
}

function frameSections(frame: Frame, set: FieldCommit): HTMLElement[] {
  return [
    heading('Frame'),
    fieldRow('Title', textField('title', frame.title, WHITEBOARD_LIMITS.title, (title) => set({ title: title.trim() }))),
    checkboxField('collapsed', 'Stacked as one card', frame.collapsed, (collapsed) => set({ collapsed })),
  ];
}

function legendEditor(legend: readonly LegendEntry[], latestLegend: LatestItems<LegendEntry>, commitLegend: (legend: LegendEntry[]) => void): HTMLElement {
  const editing = listEditing(latestLegend, commitLegend);
  const rows = legend.map((entry, index) => {
    const row = el('div', 'wb-inspect-row wb-inspect-legend-row');
    const entryNumber = index + 1;
    row.append(
      selectField(`legend-${index}-tone`, TONE_CHOICES, entry.tone, (tone) => {
        const nextTone = TONES.find((known) => known === tone);
        if (nextTone) editing.edit(index, (latestEntry) => ({ ...latestEntry, tone: nextTone }));
      }, `Legend entry ${entryNumber} tone`),
      textField(`legend-${index}-label`, entry.label, MAX_WIRE_LABEL, (label) => {
        if (label.trim()) editing.edit(index, (latestEntry) => ({ ...latestEntry, label: label.trim() }));
      }, `Legend entry ${entryNumber} label`),
      checkboxField(`legend-${index}-dashed`, 'Dashed', entry.dashed, (dashed) => editing.edit(index, (latestEntry) => ({ ...latestEntry, dashed }))),
      actionButton(`legend-${index}-remove`, 'Remove', () => editing.remove(index), `Remove legend entry ${entry.label}`),
    );
    return row;
  });
  const addEntry = actionButton('legend-add', 'Add entry', () => editing.append(() => ({ tone: 'plain', dashed: false, label: 'meaning' })));
  addEntry.disabled = legend.length >= MAX_LEGEND_ENTRIES;
  return listSection('Legend', rows, addEntry);
}

function stepSections(step: Step, set: FieldCommit): HTMLElement[] {
  return [
    heading('Step'),
    fieldRow('Status', selectField('step-status', STEP_STATUS_CHOICES, step.status, (status) => {
      const chosen = STEP_STATUSES.find((candidate) => candidate === status);
      if (chosen) set({ step: { status: chosen } });
    })),
    el('p', 'wb-inspect-hint', 'A wire from one step to another means the second is built after the first.'),
  ];
}

function boardSections(board: Board, latestBoard: () => Board | null, send: (ops: Op[]) => void, codeSessionChoices: readonly Choice[], close: () => void): HTMLElement[] {
  const codeSessionOptions = [{ value: '', text: 'None' }, ...codeSessionChoices];
  return [
    heading('Board'),
    actionButton('board-settings-close', 'Close', close, 'Close board settings'),
    fieldRow('Title', textField('board-title', board.title, WHITEBOARD_LIMITS.title, (title) => {
      if (title.trim()) send([{ op: 'board', title: title.trim() }]);
    })),
    fieldRow('Caption', textField('board-caption', board.caption ?? '', MAX_CAPTION, (caption) => send([{ op: 'board', caption: caption.trim() || null }]))),
    fieldRow('Code session', selectField('board-code-session', codeSessionOptions, board.codeSessionId ?? '', (sessionId) => send([{ op: 'board', codeSessionId: sessionId || null }]))),
    legendEditor(board.legend, () => latestBoard()?.legend ?? null, (legend) => send([{ op: 'board', legend }])),
  ];
}

function selectionActionsRow(selected: readonly BoardElement[], actions: SelectionActions): HTMLElement {
  const boxes = selected.filter((element) => element.kind === 'box');
  const [soleBox] = boxes;
  const row = el('div', 'wb-inspect-actions');
  if (soleBox && selected.length === 1) row.append(actionButton('add-note', 'Add note', () => actions.addNoteOn(soleBox.id)));
  if (boxes.length > 0) row.append(actionButton('add-frame', 'Frame', actions.frameSelectedBoxes, boxes.length === 1 ? 'Frame this box' : 'Frame selected boxes'));
  if (boxes.length > 1) row.append(actionButton('add-stack', 'Stack', actions.stackSelectedBoxes, 'Stack selected boxes'));
  const deleteButton = button({ variant: 'danger', size: 'small', label: 'Delete', action: 'delete-selection', onClick: actions.removeSelected });
  deleteButton.classList.add('wb-inspect-delete');
  row.append(deleteButton);
  return row;
}

function linkedFileSections(box: Box, linkState: LinkStateOfBox | null, latestMedia: () => BoxMedia | null, set: FieldCommit): HTMLElement[] {
  const media = linkableMediaOf(box);
  return media ? [linkedFileSection(media, linkState, latestMedia, set)] : [];
}

function elementSections(element: BoardElement, latestBoard: () => Board | null, layout: BoardLayout | null, linkState: LinkStateOfBox | null, send: (ops: Op[]) => void): HTMLElement[] {
  const set: FieldCommit = (fields) => send([{ op: 'set', id: element.id, fields }]);
  const latest = () => latestBoard()?.elements.get(element.id);
  switch (element.kind) {
    case 'box': return boxSections(element, latest, layout, linkState, set);
    case 'wire': return wireSections(element, set);
    case 'frame': return frameSections(element, set);
    case 'stroke': return [heading('Ink')];
  }
}

function worthALookRows(ref: string, worthALookReasonOf: (ref: string) => string | null): HTMLElement[] {
  const reason = worthALookReasonOf(ref);
  return reason ? [el('p', 'wb-inspect-worth-a-look', `Worth a look: ${reason}`)] : [];
}

function openInReviewRows(board: Board, element: BoardElement, options: ReviewRowOptions): HTMLElement[] {
  const refs = refsOfElement(element);
  if (refs.length === 0) return [];
  const hasCodeSession = board.codeSessionId !== null;
  const rows = refs.flatMap((ref, index) => {
    const row = el('div', 'wb-inspect-row wb-inspect-review-row');
    const openButton = actionButton(`review-${index}`, 'Open in review', () => options.openRef(ref), `Open ${ref} in review`);
    openButton.disabled = !hasCodeSession;
    row.append(el('code', 'wb-inspect-ref', ref), openButton);
    return [row, ...worthALookRows(ref, options.worthALookReasonOf)];
  });
  const hint = hasCodeSession ? [] : [el('p', 'wb-inspect-hint', 'Set the board code session to open refs in review.')];
  return [heading('In review'), ...rows, ...hint];
}

function openInReviewSection(board: Board, element: BoardElement, options: ReviewRowOptions): HTMLElement {
  const section = el('div', 'wb-inspect-review');
  section.append(...openInReviewRows(board, element, options));
  return section;
}

function isTypingIn(container: HTMLElement): boolean {
  const active = document.activeElement;
  if (!active || !container.contains(active)) return false;
  if (active instanceof HTMLInputElement && active.type === 'text') return true;
  return active.closest('.wb-icon-popover') !== null;
}

export function createBoardInspector(options: BoardInspectorOptions) {
  const { container } = options;
  container.setAttribute('aria-label', 'Properties');
  const send = (ops: Op[]) => void options.sendOps(ops);
  let paintedSelectedIds: ReadonlySet<string> = new Set();
  let isRepainting = false;
  let isShowingBoardSettings = false;

  function soleSelectedElement(board: Board, selectedIds: ReadonlySet<string>): BoardElement | undefined {
    if (selectedIds.size !== 1) return undefined;
    const [selectedId] = selectedIds;
    return selectedId === undefined ? undefined : board.elements.get(selectedId);
  }

  function repaintReviewWhileTyping(board: Board, selectedIds: ReadonlySet<string>): void {
    const element = soleSelectedElement(board, selectedIds);
    const reviewSection = container.querySelector<HTMLElement>('.wb-inspect-review');
    if (!element || !reviewSection) return;
    reviewSection.replaceChildren(...openInReviewRows(board, element, options));
  }

  function sectionsFor(board: Board, selectedIds: ReadonlySet<string>): HTMLElement[] {
    const selected = [...selectedIds].flatMap((selectedId) => board.elements.get(selectedId) ?? []);
    if (selectedIds.size > 1) return [heading(`${selected.length} selected`), selectionActionsRow(selected, options)];
    const element = soleSelectedElement(board, selectedIds);
    if (!element) return boardSections(board, options.currentBoard, send, options.codeSessionChoices(), closeBoardSettings);
    return [...elementSections(element, options.currentBoard, options.layout(), options.linkStateOf(element.id), send), openInReviewSection(board, element, options), selectionActionsRow(selected, options)];
  }

  function paint(selectedIds: ReadonlySet<string>): void {
    paintedSelectedIds = selectedIds;
    if (selectedIds.size > 0) isShowingBoardSettings = false;
    const board = options.currentBoard();
    container.hidden = !board || (selectedIds.size === 0 && !isShowingBoardSettings);
    if (!board || container.hidden) return;
    if (isTypingIn(container)) {
      repaintReviewWhileTyping(board, selectedIds);
      return;
    }
    const active = document.activeElement;
    const focusedField = active instanceof HTMLElement && container.contains(active) ? active.dataset.field : undefined;
    isRepainting = true;
    container.replaceChildren(...sectionsFor(board, selectedIds));
    if (focusedField) container.querySelector<HTMLElement>(`[data-field="${CSS.escape(focusedField)}"]`)?.focus();
    isRepainting = false;
  }

  function openBoardSettings(): void {
    isShowingBoardSettings = true;
    paint(paintedSelectedIds);
    container.querySelector<HTMLElement>('[data-field="board-caption"]')?.focus();
  }

  function closeBoardSettings(): void {
    if (!isShowingBoardSettings) return;
    isShowingBoardSettings = false;
    paint(paintedSelectedIds);
  }

  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isShowingBoardSettings) return;
    event.preventDefault();
    closeBoardSettings();
  });

  container.addEventListener('focusout', (event) => {
    if (isRepainting || container.hidden || (event.relatedTarget instanceof Node && container.contains(event.relatedTarget))) return;
    queueMicrotask(() => paint(paintedSelectedIds));
  });

  return { paint, openBoardSettings, closeBoardSettings };
}

export type BoardInspector = ReturnType<typeof createBoardInspector>;
