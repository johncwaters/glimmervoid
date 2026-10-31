import type { Board, Box, Element as BoardElement, Frame, Note, Op, Panel, Unit, Wire } from '#shared/contracts/whiteboard.ts';
import { AnchorRef, BOX_CHANGES, UNIT_STATUSES, WHITEBOARD_LIMITS } from '#shared/contracts/whiteboard.ts';
import type { BoardLayout } from '#shared/whiteboard-layout-core.ts';
import { el } from '../dom-helpers.ts';
import { refsOfElement } from '#shared/whiteboard-anchor-core.ts';

type BoxLine = Box['lines'][number];
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
}

const MAX_OUTPUTS = 8;
const MAX_LEGEND_ENTRIES = 12;
const MAX_OUTPUT_LABEL = 30;
const MAX_WIRE_LABEL = 40;
const MAX_LINE_KEY = 40;
const MAX_CAPTION = 400;
const MAX_REF = 200;
const MAX_REFS = 8;
const NEW_REF = 'README.md';
const FREE_PLACEMENT = '';
const LINE_STYLES: readonly BoxLine['style'][] = ['text', 'code', 'item', 'numbered', 'kv'];
const TONES: readonly Wire['tone'][] = ['plain', 'fail', 'join', 'lane'];
const LINE_STYLE_CHOICES = choicesOf(LINE_STYLES);
const TONE_CHOICES = choicesOf(TONES);
const SHAPE_CHOICES = choicesOf(['box', 'decision'] satisfies Box['shape'][]);
const CHANGE_CHOICES = choicesOf(BOX_CHANGES);
const UNIT_STATUS_CHOICES = choicesOf(UNIT_STATUSES);
const SIDE_CHOICES: readonly Choice[] = [{ value: '', text: 'auto' }, ...choicesOf(['left', 'right', 'top', 'bottom'])];
const DEFAULT_OUTPUTS: Box['outputs'] = [{ id: 'yes', label: 'yes' }, { id: 'no', label: 'no' }];

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
  const button = el('button', 'wb-button wb-inspect-action', label);
  button.type = 'button';
  button.dataset.field = field;
  if (accessibleName) button.setAttribute('aria-label', accessibleName);
  button.addEventListener('click', onClick);
  return button;
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

function optionalRefField(field: string, ref: string | null, commit: (ref: string | null) => void, accessibleName: string): HTMLInputElement {
  const input = textField(field, ref ?? '', MAX_REF, (text) => {
    if (!text.trim()) {
      commit(null);
      return;
    }
    const nextRef = validRefOf(text);
    if (nextRef) commit(nextRef);
  }, accessibleName);
  input.placeholder = 'ref: path#L12';
  return input;
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
      actionButton(`ref-${index}-remove`, 'remove', () => editing.remove(index), `Remove ref ${ref}`),
    );
    return row;
  });
  const addRef = actionButton('ref-add', 'add ref', () => editing.append(() => NEW_REF), `Add a ref to ${owner}`);
  addRef.disabled = refs.length >= MAX_REFS;
  return listSection('Refs', rows, addRef);
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
      optionalRefField(`line-${index}-ref`, line.ref, (ref) => editing.edit(index, (latestLine) => ({ ...latestLine, ref })), `Line ${lineNumber} ref`),
      actionButton(`line-${index}-remove`, 'remove', () => editing.remove(index), `Remove line ${lineNumber}`),
    );
    return row;
  });
  const addLine = actionButton('line-add', 'add line', () => editing.append(() => ({ text: 'new line', muted: false, style: 'text', key: null, ref: null })), `Add a line to ${owner}`);
  addLine.disabled = lines.length >= WHITEBOARD_LIMITS.linesPerBox;
  return listSection('Lines', rows, addLine);
}

function nextOutputId(outputs: readonly Box['outputs'][number][]): string {
  const takenIds = new Set(outputs.map((output) => output.id));
  let suffix = outputs.length + 1;
  while (takenIds.has(`exit-${suffix}`)) suffix += 1;
  return `exit-${suffix}`;
}

function outputsEditor(box: Box, latestOutputs: LatestItems<Box['outputs'][number]>, set: FieldCommit): HTMLElement {
  const editing = listEditing(latestOutputs, (outputs) => set({ outputs }));
  const rows = box.outputs.map((output, index) => {
    const row = el('div', 'wb-inspect-row');
    row.append(
      textField(`output-${output.id}-label`, output.label, MAX_OUTPUT_LABEL, (label) => {
        if (label.trim()) editing.edit(index, (latestOutput) => ({ ...latestOutput, label: label.trim() }));
      }, `Output ${output.id} label`),
      actionButton(`output-${output.id}-remove`, 'remove', () => editing.remove(index), `Remove output ${output.label}`),
    );
    return row;
  });
  const addOutput = actionButton('output-add', 'add output', () => editing.append((outputs) => ({ id: nextOutputId(outputs), label: 'exit' })));
  addOutput.disabled = box.outputs.length >= MAX_OUTPUTS;
  return listSection('Outputs', rows, addOutput);
}

function placementOf(box: Box): string {
  return box.at === null && box.near === null ? box.column ?? FREE_PLACEMENT : FREE_PLACEMENT;
}

function boxSections(board: Board, box: Box, latest: () => BoardElement | undefined, layout: BoardLayout | null, set: FieldCommit): HTMLElement[] {
  const latestBox = () => {
    const element = latest();
    return element?.kind === 'box' ? element : null;
  };
  const columnChoices = [{ value: FREE_PLACEMENT, text: 'free' }, ...board.columns.map((column) => ({ value: column.id, text: column.title || column.id }))];
  const laneChoices = [{ value: '', text: 'none' }, ...board.lanes.map((lane) => ({ value: lane.id, text: lane.label || lane.id }))];
  const commitPlacement = (columnId: string) => {
    if (columnId !== FREE_PLACEMENT) {
      set({ column: columnId, at: null, near: null });
      return;
    }
    const laidOut = layout?.elements.find((element) => element.id === box.id);
    if (!layout || laidOut?.kind !== 'box') return;
    set({ at: { x: laidOut.x, y: laidOut.y - layout.pinnedOffsetY }, near: null });
  };
  const commitShape = (shape: string) => {
    const outputs = latestBox()?.outputs ?? [];
    if (shape === 'decision') set({ shape, outputs: outputs.length > 0 ? outputs : DEFAULT_OUTPUTS });
    if (shape === 'box') set({ shape, outputs: [] });
  };
  const commitChange = (change: string) => {
    if (change === 'relabeled') {
      set({ change, was: latestBox()?.was ?? box.title });
      return;
    }
    set({ change, was: null });
  };
  return [
    heading(box.shape === 'decision' ? 'Decision' : 'Box'),
    fieldRow('Title', textField('title', box.title, WHITEBOARD_LIMITS.title, (title) => {
      if (title.trim()) set({ title: title.trim() });
    })),
    fieldRow('Shape', selectField('shape', SHAPE_CHOICES, box.shape, commitShape)),
    fieldRow('Column', selectField('column', columnChoices, placementOf(box), commitPlacement)),
    fieldRow('Lane', selectField('lane', laneChoices, box.lane ?? '', (lane) => set({ lane: lane || null }))),
    fieldRow('Change', selectField('change', CHANGE_CHOICES, box.change, commitChange)),
    ...(box.change === 'relabeled' ? [fieldRow('Was', textField('was', box.was ?? '', WHITEBOARD_LIMITS.title, (was) => {
      if (was.trim()) set({ was: was.trim() });
    }))] : []),
    ...(box.shape === 'decision' ? [outputsEditor(box, () => latestBox()?.outputs ?? null, set)] : []),
    refsEditor('this box', box.refs, () => latestBox()?.refs ?? null, (refs) => set({ refs })),
    linesEditor('this box', box.lines, () => latestBox()?.lines ?? null, (lines) => set({ lines })),
  ];
}

function wireSections(board: Board, wire: Wire, set: FieldCommit): HTMLElement[] {
  const from = board.elements[wire.from];
  const outputChoices = from?.kind === 'box' && from.shape === 'decision'
    ? [{ value: '', text: 'none' }, ...from.outputs.map((output) => ({ value: output.id, text: output.label }))]
    : [];
  return [
    heading('Wire'),
    fieldRow('Label', textField('label', wire.label ?? '', MAX_WIRE_LABEL, (label) => set({ label: label.trim() || null }))),
    fieldRow('Tone', selectField('tone', TONE_CHOICES, wire.tone, (tone) => set({ tone }))),
    checkboxField('dashed', 'dashed', wire.dashed, (dashed) => set({ dashed })),
    checkboxField('back', 'returns to an earlier step', wire.back, (back) => set({ back })),
    fieldRow('Leaves from', selectField('fromSide', SIDE_CHOICES, wire.fromSide ?? '', (side) => set({ fromSide: side || null }))),
    fieldRow('Arrives at', selectField('toSide', SIDE_CHOICES, wire.toSide ?? '', (side) => set({ toSide: side || null }))),
    ...(outputChoices.length > 0 ? [fieldRow('From output', selectField('fromOutput', outputChoices, wire.fromOutput ?? '', (output) => set({ fromOutput: output || null })))] : []),
  ];
}

function frameSections(frame: Frame, set: FieldCommit): HTMLElement[] {
  return [
    heading('Frame'),
    fieldRow('Title', textField('title', frame.title, WHITEBOARD_LIMITS.title, (title) => set({ title: title.trim() }))),
    checkboxField('loop', 'repeats as a loop', frame.loop, (loop) => set({ loop })),
  ];
}

function panelSections(panel: Panel, latest: () => BoardElement | undefined, set: FieldCommit): HTMLElement[] {
  const latestLines = () => {
    const element = latest();
    return element?.kind === 'panel' ? element.lines : null;
  };
  return [
    heading('Panel'),
    fieldRow('Title', textField('title', panel.title, WHITEBOARD_LIMITS.title, (title) => {
      if (title.trim()) set({ title: title.trim() });
    })),
    linesEditor('this panel', panel.lines, latestLines, (lines) => set({ lines })),
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
      checkboxField(`legend-${index}-dashed`, 'dashed', entry.dashed, (dashed) => editing.edit(index, (latestEntry) => ({ ...latestEntry, dashed }))),
      checkboxField(`legend-${index}-back`, 'returns', entry.back, (back) => editing.edit(index, (latestEntry) => ({ ...latestEntry, back }))),
      actionButton(`legend-${index}-remove`, 'remove', () => editing.remove(index), `Remove legend entry ${entry.label}`),
    );
    return row;
  });
  const addEntry = actionButton('legend-add', 'add entry', () => editing.append(() => ({ tone: 'plain', dashed: false, back: false, label: 'meaning' })));
  addEntry.disabled = legend.length >= MAX_LEGEND_ENTRIES;
  return listSection('Legend', rows, addEntry);
}

function noteSections(note: Note, set: FieldCommit): HTMLElement[] {
  return [
    heading('Note'),
    fieldRow('Ref', optionalRefField('ref', note.ref, (ref) => set({ ref }), 'Ref')),
    el('p', 'wb-inspect-hint', 'Edit a note from its box.'),
  ];
}

function unitSections(unit: Unit, latest: () => BoardElement | undefined, set: FieldCommit): HTMLElement[] {
  const latestRefs = () => {
    const element = latest();
    return element?.kind === 'unit' ? element.refs : null;
  };
  return [
    heading('Unit'),
    fieldRow('Status', selectField('unit-status', UNIT_STATUS_CHOICES, unit.status, (status) => {
      const chosen = UNIT_STATUSES.find((candidate) => candidate === status);
      if (chosen) set({ status: chosen });
    })),
    refsEditor('this unit', unit.refs, latestRefs, (refs) => set({ refs })),
    el('p', 'wb-inspect-hint', 'Agents edit units with glimmervoid whiteboard plan.'),
  ];
}

function boardSections(board: Board, latestBoard: () => Board | null, send: (ops: Op[]) => void, codeSessionChoices: readonly Choice[]): HTMLElement[] {
  const codeSessionOptions = [{ value: '', text: 'none' }, ...codeSessionChoices];
  return [
    heading('Board'),
    fieldRow('Title', textField('board-title', board.title, WHITEBOARD_LIMITS.title, (title) => {
      if (title.trim()) send([{ op: 'board', title: title.trim() }]);
    })),
    fieldRow('Caption', textField('board-caption', board.caption ?? '', MAX_CAPTION, (caption) => send([{ op: 'board', caption: caption.trim() || null }]))),
    fieldRow('Code session', selectField('board-code-session', codeSessionOptions, board.codeSessionId ?? '', (sessionId) => send([{ op: 'board', codeSessionId: sessionId || null }]))),
    legendEditor(board.legend, () => latestBoard()?.legend ?? null, (legend) => send([{ op: 'board', legend }])),
  ];
}

function elementSections(board: Board, element: BoardElement, latestBoard: () => Board | null, layout: BoardLayout | null, send: (ops: Op[]) => void): HTMLElement[] {
  const set: FieldCommit = (fields) => send([{ op: 'set', id: element.id, fields }]);
  const latest = () => latestBoard()?.elements[element.id];
  switch (element.kind) {
    case 'box': return boxSections(board, element, latest, layout, set);
    case 'wire': return wireSections(board, element, set);
    case 'frame': return frameSections(element, set);
    case 'panel': return panelSections(element, latest, set);
    case 'note': return noteSections(element, set);
    case 'unit': return unitSections(element, latest, set);
  }
}

function openInReviewSection(board: Board, element: BoardElement, openRef: (ref: string) => void): HTMLElement[] {
  const refs = refsOfElement(element);
  if (refs.length === 0) return [];
  const hasCodeSession = board.codeSessionId !== null;
  const rows = refs.map((ref, index) => {
    const row = el('div', 'wb-inspect-row wb-inspect-review-row');
    const openButton = actionButton(`review-${index}`, 'open in review', () => openRef(ref), `Open ${ref} in review`);
    openButton.disabled = !hasCodeSession;
    row.append(el('code', 'wb-inspect-ref', ref), openButton);
    return row;
  });
  const hint = hasCodeSession ? [] : [el('p', 'wb-inspect-hint', 'Set the board code session to open refs in review.')];
  return [heading('In review'), ...rows, ...hint];
}

function isTypingIn(container: HTMLElement): boolean {
  const active = document.activeElement;
  return container.contains(active) && active instanceof HTMLInputElement && active.type === 'text';
}

export function createBoardInspector(options: BoardInspectorOptions) {
  const { container } = options;
  container.setAttribute('aria-label', 'Properties');
  const send = (ops: Op[]) => void options.sendOps(ops);
  let paintedSelectedIds: ReadonlySet<string> = new Set();
  let isRepainting = false;

  function sectionsFor(board: Board, selectedIds: ReadonlySet<string>): HTMLElement[] {
    if (selectedIds.size > 1) return [heading(`${selectedIds.size} selected`)];
    const [selectedId] = selectedIds;
    const element = selectedId === undefined ? undefined : board.elements[selectedId];
    if (!element) return boardSections(board, options.currentBoard, send, options.codeSessionChoices());
    return [...elementSections(board, element, options.currentBoard, options.layout(), send), ...openInReviewSection(board, element, options.openRef)];
  }

  function paint(selectedIds: ReadonlySet<string>): void {
    paintedSelectedIds = selectedIds;
    const board = options.currentBoard();
    container.hidden = !board;
    if (!board || isTypingIn(container)) return;
    const active = document.activeElement;
    const focusedField = active instanceof HTMLElement && container.contains(active) ? active.dataset.field : undefined;
    isRepainting = true;
    container.replaceChildren(...sectionsFor(board, selectedIds));
    if (focusedField) container.querySelector<HTMLElement>(`[data-field="${CSS.escape(focusedField)}"]`)?.focus();
    isRepainting = false;
  }

  container.addEventListener('focusout', (event) => {
    if (isRepainting || (event.relatedTarget instanceof Node && container.contains(event.relatedTarget))) return;
    queueMicrotask(() => paint(paintedSelectedIds));
  });

  return { paint };
}

export type BoardInspector = ReturnType<typeof createBoardInspector>;
