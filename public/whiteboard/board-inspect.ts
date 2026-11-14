import type { Board, Box, BoxLine, BoxMedia, Dial, DialValue, Element as BoardElement, Frame, LinkStateOfBox, Op, Wire } from '#shared/contracts/whiteboard.ts';
import { DEVICE_CATALOG, DEVICE_FITS, DEVICE_NAMES, PLACED_DEVICE } from '#shared/whiteboard-devices.ts';
import { PLACED_ICON } from '#shared/whiteboard-icons.ts';
import { AnchorRef, BOX_CHANGES, LINE_STYLES, MediaLink, dialValuesOfBox, SIDES, STEP_STATUSES, WHITEBOARD_LIMITS, WIRE_TONES } from '#shared/contracts/whiteboard.ts';
import { BOX_SHAPES, isBorderlessBox, SHAPE_TRAITS } from '#shared/whiteboard-shapes.ts';
import type { BoxShape } from '#shared/whiteboard-shapes.ts';
import { customLegendLabelByKey, defaultWireStyleLabel, wireStyleKey } from '#shared/whiteboard-layout-core.ts';
import type { BoardLayout } from '#shared/whiteboard-layout-core.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { refsOfElement } from '#shared/whiteboard-anchor-core.ts';
import { iconGlyph, iconPicker } from './board-icon-picker.ts';
import { LINE_STYLE_LABELS, lineWithStyle } from './board-line-edit.ts';

type LegendEntry = Board['legend'][number];
type Choice = { value: string; text: string };
type FieldCommit = (fields: Record<string, unknown>) => void;
type LatestItems<Item> = () => readonly Item[] | null;
type Side = (typeof SIDES)[number];
type StepChoice = 'none' | (typeof STEP_STATUSES)[number];
type DisclosureName = 'more' | 'ends';

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

interface Disclosures {
  latchOpenState: (name: DisclosureName, hasSetField: boolean) => boolean;
  remember: (name: DisclosureName, isOpen: boolean) => void;
}

interface WireStyle {
  tone: Wire['tone'];
  dashed: boolean;
}

const NEW_REF = 'README.md';
export const WIRE_TONE_LABELS: Readonly<Record<Wire['tone'], string>> = { plain: 'Plain', fail: 'Failure', join: 'Join' };
const CHANGE_LABELS: Readonly<Record<Box['change'], string>> = { none: 'Unchanged', added: 'Added', removed: 'Removed', relabeled: 'Renamed' };
const STEP_CHOICE_LABELS: Readonly<Record<StepChoice, string>> = { none: 'Not a step', planned: 'Planned', building: 'Building', landed: 'Landed' };
const SIDE_LABELS: Readonly<Record<Side | 'auto', string>> = { auto: 'Auto', left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom' };
const DEVICE_FIT_LABELS: Readonly<Record<(typeof DEVICE_FITS)[number], string>> = { fill: 'Fill the screen', fit: 'Show all' };
const LINE_STYLE_CHOICES = choicesOf(LINE_STYLES, LINE_STYLE_LABELS);
const CHANGE_CHOICES = choicesOf(BOX_CHANGES, CHANGE_LABELS);
const STEP_CHOICES = choicesOf(['none', ...STEP_STATUSES], STEP_CHOICE_LABELS);
const SIDE_CHOICES = choicesOf(['auto', ...SIDES], SIDE_LABELS);
const DEVICE_CHOICES: readonly Choice[] = DEVICE_NAMES.map((name) => ({ value: name, text: DEVICE_CATALOG[name].label }));
const FIT_CHOICES = choicesOf(DEVICE_FITS, DEVICE_FIT_LABELS);
const WIRE_STYLES: readonly WireStyle[] = WIRE_TONES.flatMap((tone) => [false, true].map((dashed) => ({ tone, dashed })));

function choicesOf<Value extends string>(values: readonly Value[], labels: Readonly<Record<Value, string>>): Choice[] {
  return values.map((value) => ({ value, text: labels[value] }));
}

function heading(text: string): HTMLElement {
  return el('h3', 'wb-inspect-heading', text);
}

function fieldRow(label: string, control: HTMLElement): HTMLElement {
  const row = el('label', 'wb-inspect-field');
  row.append(el('span', 'wb-inspect-label', label), control);
  return row;
}

function inlineRow(...controls: HTMLElement[]): HTMLElement {
  const row = el('div', 'wb-inspect-row');
  row.append(...controls);
  return row;
}

function textField(field: string, value: string, maxLength: number, commit: (value: string) => void, accessibleName?: string): HTMLInputElement {
  const input = markAsNotCredential(el('input', 'wb-inspect-input'));
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

export function actionButton(field: string, label: string, onClick: () => void, accessibleName?: string): HTMLButtonElement {
  const inspectButton = button({ variant: 'quiet', size: 'small', label, action: label.toLowerCase().replaceAll(' ', '-'), onClick });
  inspectButton.dataset.field = field;
  if (accessibleName) inspectButton.setAttribute('aria-label', accessibleName);
  return inspectButton;
}

function removeButton(field: string, accessibleName: string, onClick: () => void): HTMLButtonElement {
  const remove = button({ variant: 'icon', size: 'small', label: accessibleName, icon: createLineIcon(CLOSE_ICON_PATH, '1.5'), action: 'remove', onClick });
  remove.dataset.field = field;
  return remove;
}

export function pickButton(field: string, label: string, icon: SVGElement, isPressed: boolean, onPick: () => void): HTMLButtonElement {
  const pick = button({ variant: 'icon', size: 'small', label, icon, action: field, onClick: () => {
    if (!isPressed) onPick();
  } });
  pick.dataset.field = field;
  pick.setAttribute('aria-pressed', String(isPressed));
  return pick;
}

export function pickGroup(label: string, className: string, picks: HTMLElement[]): HTMLElement {
  const group = el('div', `wb-inspect-picks ${className}`);
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  group.append(...picks);
  return group;
}

function listSection(title: string, rows: HTMLElement[], addButton: HTMLButtonElement): HTMLElement {
  const section = el('div', 'wb-inspect-list');
  section.append(el('span', 'wb-inspect-label', title), ...rows, addButton);
  return section;
}

function disclosure(name: DisclosureName, summary: string, hasSetField: boolean, disclosures: Disclosures, contents: HTMLElement[]): HTMLElement {
  const details = el('details', 'wb-inspect-disclosure');
  details.dataset.disclosure = name;
  details.open = disclosures.latchOpenState(name, hasSetField);
  const summaryRow = el('summary', 'wb-inspect-summary', summary);
  summaryRow.dataset.field = `${name}-summary`;
  summaryRow.addEventListener('click', () => disclosures.remember(name, !details.open));
  const body = el('div', 'wb-inspect-disclosure-body');
  body.append(...contents);
  details.append(summaryRow, body);
  return details;
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
  const rows = refs.map((ref, index) => inlineRow(
    textField(`ref-${index}`, ref, WHITEBOARD_LIMITS.ref, (text) => {
      const nextRef = validRefOf(text);
      if (nextRef) editing.edit(index, () => nextRef);
    }, `Ref ${index + 1}`),
    removeButton(`ref-${index}-remove`, `Remove ref ${ref}`, () => editing.remove(index)),
  ));
  const addRef = actionButton('ref-add', 'Add ref', () => editing.append(() => NEW_REF), `Add a ref to ${owner}`);
  addRef.disabled = refs.length >= WHITEBOARD_LIMITS.refsPerElement;
  return listSection('Refs', rows, addRef);
}

function linkedFileStatusText(media: BoxMedia, linkState: LinkStateOfBox | null): string {
  if (linkState) return linkState.text;
  return media.link ? 'In sync with the file' : 'Not linked: the card is a board copy';
}

function linkedFileSection(media: BoxMedia, linkState: LinkStateOfBox | null, latestMedia: () => BoxMedia | null, set: FieldCommit): HTMLElement {
  const pathInput = markAsNotCredential(el('input', 'wb-inspect-input'));
  pathInput.type = 'text';
  pathInput.value = media.link?.path ?? '';
  pathInput.maxLength = MediaLink.shape.path.maxLength ?? WHITEBOARD_LIMITS.ref;
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
  const section = el('div', 'wb-inspect-list');
  section.append(el('span', 'wb-inspect-label', 'Linked file'), pathInput, inlineRow(linkButton, unlinkButton), status);
  return section;
}

function linesEditor(owner: string, lines: readonly BoxLine[], latestLines: LatestItems<BoxLine>, commitLines: (lines: BoxLine[]) => void): HTMLElement {
  const editing = listEditing(latestLines, commitLines);
  const rows = lines.map((line, index) => {
    const row = el('div', 'wb-inspect-row wb-inspect-line');
    const lineNumber = index + 1;
    row.append(selectField(`line-${index}-style`, LINE_STYLE_CHOICES, line.style, (style) => {
      const nextStyle = LINE_STYLES.find((known) => known === style);
      if (nextStyle) editing.edit(index, (latestLine) => lineWithStyle(latestLine, nextStyle));
    }, `Line ${lineNumber} style`));
    if (line.style === 'kv') {
      row.append(textField(`line-${index}-key`, line.key ?? '', WHITEBOARD_LIMITS.lineKey, (key) => {
        if (key.trim()) editing.edit(index, (latestLine) => ({ ...latestLine, key: key.trim() }));
      }, `Line ${lineNumber} key`));
    }
    row.append(
      textField(`line-${index}-text`, line.text, WHITEBOARD_LIMITS.line, (text) => editing.edit(index, (latestLine) => ({ ...latestLine, text })), `Line ${lineNumber} text`),
      removeButton(`line-${index}-remove`, `Remove line ${lineNumber}`, () => editing.remove(index)),
    );
    return row;
  });
  const addLine = actionButton('line-add', 'Add line', () => editing.append(() => ({ text: 'new line', muted: false, style: 'text', key: null })), `Add a line to ${owner}`);
  addLine.disabled = lines.length >= WHITEBOARD_LIMITS.linesPerBox;
  return listSection('Lines', rows, addLine);
}

function linkableMediaOf(box: Box | null): BoxMedia | null {
  const media = box?.media ?? null;
  return media?.kind === 'doc' || media?.kind === 'page' ? media : null;
}

function shapeRow(shape: BoxShape, commitShape: (shape: BoxShape) => void): HTMLElement {
  return pickGroup('Shape', 'wb-inspect-shapes', BOX_SHAPES.map((choice) => (
    pickButton(`shape-${choice}`, SHAPE_TRAITS[choice].label, iconGlyph(SHAPE_TRAITS[choice].pickerIcon), choice === shape, () => commitShape(choice))
  )));
}

function titleRow(box: Box, set: FieldCommit): HTMLElement {
  const title = textField('title', box.title, WHITEBOARD_LIMITS.title, (text) => {
    if (text.trim()) set({ title: text.trim() });
  }, 'Title');
  const picker = iconPicker({ field: 'icon', icon: box.icon, isRequired: box.shape === 'icon', accessibleName: 'Box icon', commit: (icon) => set({ icon }) });
  const row = el('div', 'wb-inspect-row wb-inspect-title-row');
  row.append(picker, title);
  return row;
}

function hasSetMoreField(box: Box): boolean {
  if (box.change !== 'none' || box.refs.length > 0 || box.media?.link) return true;
  if (Object.keys(box.params).length > 0) return true;
  return box.shape === 'device' && box.fit !== 'fill';
}

function boxSections(box: Box, latest: () => BoardElement | undefined, layout: BoardLayout | null, linkState: LinkStateOfBox | null, disclosures: Disclosures, set: FieldCommit): HTMLElement[] {
  const traits = SHAPE_TRAITS[box.shape];
  const latestBox = () => {
    const element = latest();
    return element?.kind === 'box' ? element : null;
  };
  const latestLines = () => latestBox()?.lines ?? null;
  const laidOutPlace = () => {
    const laidOut = layout?.elements.find((element) => element.id === box.id);
    if (!layout || laidOut?.kind !== 'box') return null;
    return { x: laidOut.x, y: laidOut.y - layout.pinnedOffsetY };
  };
  const commitShape = (shape: BoxShape) => {
    if (shape === 'icon') {
      set({ shape, icon: latestBox()?.icon ?? PLACED_ICON });
      return;
    }
    if (shape === 'device') {
      set({ shape, device: PLACED_DEVICE });
      return;
    }
    set({ shape });
  };
  const commitStep = (choice: string) => {
    const status = STEP_STATUSES.find((known) => known === choice);
    if (status) {
      set({ step: { status } });
      return;
    }
    const stepBox = latestBox();
    if (stepBox?.place !== 'plan') {
      set({ step: null });
      return;
    }
    const at = laidOutPlace();
    set({ step: null, place: at ? { at } : 'aside' });
  };
  const commitChange = (change: string) => {
    if (change === 'relabeled') {
      set({ change, was: latestBox()?.was ?? box.title });
      return;
    }
    set({ change, was: null });
  };
  const moreFields = [
    fieldRow('Change', selectField('change', CHANGE_CHOICES, box.change, commitChange)),
    ...(box.change === 'relabeled' ? [fieldRow('Was', textField('was', box.was ?? '', WHITEBOARD_LIMITS.title, (was) => {
      if (was.trim()) set({ was: was.trim() });
    }))] : []),
    refsEditor('this box', box.refs, () => latestBox()?.refs ?? null, (refs) => set({ refs })),
    ...linkedFileSections(box, linkState, () => linkableMediaOf(latestBox()), set),
    ...dialSections(box, latestBox, set),
    ...(box.shape === 'device' ? [fieldRow('Fit', selectField('fit', FIT_CHOICES, box.fit, (fit) => set({ fit })))] : []),
  ];
  return [
    shapeRow(box.shape, commitShape),
    titleRow(box, set),
    ...(box.shape === 'device' ? [fieldRow('Device', selectField('device', DEVICE_CHOICES, box.device ?? PLACED_DEVICE, (device) => set({ device })))] : []),
    fieldRow('Step', selectField('step', STEP_CHOICES, box.step?.status ?? 'none', commitStep)),
    ...(box.step ? [el('p', 'wb-inspect-hint', 'A wire from one step to another means the second is built after the first.')] : []),
    ...(box.shape === 'note' ? [] : [checkboxField('borderless', 'Borderless', isBorderlessBox(box), (borderless) => set({ borderless }))]),
    ...(traits.holdsLines ? [linesEditor('this box', box.lines, latestLines, (lines) => set({ lines }))] : []),
    disclosure('more', 'More', hasSetMoreField(box), disclosures, moreFields),
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
  const media = box.media;
  if (media?.kind !== 'page' || media.dials.length === 0) return [];
  const dialValues = dialValuesOfBox(box);
  const commitDial = (dialId: string, value: DialValue) => {
    const latest = latestBox();
    const latestParams = latest?.params ?? {};
    set({ params: { ...latestParams, [dialId]: value } });
  };
  const section = el('div', 'wb-inspect-list');
  section.append(el('span', 'wb-inspect-label', 'Dials'), ...media.dials.map((dial) => dialControlOf(dial, dialValues[dial.id] ?? dial.default, (value) => commitDial(dial.id, value))));
  return [section];
}

function sideOf(choice: string): Side | null {
  return SIDES.find((side) => side === choice) ?? null;
}

function wireSections(wire: Wire, disclosures: Disclosures, set: FieldCommit): HTMLElement[] {
  const ends = [
    fieldRow('From side', selectField('fromSide', SIDE_CHOICES, wire.fromSide ?? 'auto', (side) => set({ fromSide: sideOf(side) }))),
    fieldRow('To side', selectField('toSide', SIDE_CHOICES, wire.toSide ?? 'auto', (side) => set({ toSide: sideOf(side) }))),
  ];
  return [
    heading('Wire'),
    fieldRow('Label', textField('label', wire.label ?? '', WHITEBOARD_LIMITS.wireLabel, (label) => set({ label: label.trim() || null }))),
    checkboxField('dashed', 'Dashed', wire.dashed, (dashed) => set({ dashed })),
    disclosure('ends', 'Ends', wire.fromSide !== null || wire.toSide !== null, disclosures, ends),
  ];
}

function frameSections(frame: Frame, set: FieldCommit): HTMLElement[] {
  return [
    heading('Frame'),
    fieldRow('Title', textField('title', frame.title, WHITEBOARD_LIMITS.title, (title) => set({ title: title.trim() }))),
    checkboxField('collapsed', 'Stacked as one card', frame.collapsed, (collapsed) => set({ collapsed })),
  ];
}

function wireStyleLabel(style: WireStyle): string {
  return style.dashed ? `${WIRE_TONE_LABELS[style.tone]}, dashed` : WIRE_TONE_LABELS[style.tone];
}

function legendStylesOf(board: Board): WireStyle[] {
  const shownKeys = new Set(board.legend.map((entry) => wireStyleKey(entry.tone, entry.dashed)));
  for (const wire of board.elements.valuesOfKind('wire')) shownKeys.add(wireStyleKey(wire.tone, wire.dashed));
  return WIRE_STYLES.filter((style) => shownKeys.has(wireStyleKey(style.tone, style.dashed)));
}

function legendWithLabel(legend: readonly LegendEntry[], style: WireStyle, label: string): LegendEntry[] {
  const entryByKey = new Map(legend.map((entry) => [wireStyleKey(entry.tone, entry.dashed), entry]));
  const editedKey = wireStyleKey(style.tone, style.dashed);
  entryByKey.set(editedKey, { tone: style.tone, dashed: style.dashed, label });
  if (!label) entryByKey.delete(editedKey);
  return [...entryByKey.values()];
}

function legendEditor(board: Board, latestLegend: LatestItems<LegendEntry>, commitLegend: (legend: LegendEntry[]) => void): HTMLElement {
  const section = el('div', 'wb-inspect-list');
  section.append(el('span', 'wb-inspect-label', 'Legend'));
  const styles = legendStylesOf(board);
  if (styles.length === 0) {
    section.append(el('p', 'wb-inspect-hint', 'Each wire style the board uses gets a legend label here.'));
    return section;
  }
  const customLabelByKey = customLegendLabelByKey(board.legend);
  for (const [index, style] of styles.entries()) {
    const label = customLabelByKey.get(wireStyleKey(style.tone, style.dashed)) ?? '';
    const input = textField(`legend-${index}`, label, WHITEBOARD_LIMITS.legendLabel, (text) => {
      const legend = latestLegend();
      if (legend) commitLegend(legendWithLabel(legend, style, text.trim()));
    }, `Legend label for ${wireStyleLabel(style).toLowerCase()} wires`);
    input.placeholder = defaultWireStyleLabel(style.tone, style.dashed) ?? 'not shown';
    section.append(fieldRow(wireStyleLabel(style), input));
  }
  return section;
}

function boardSections(board: Board, latestBoard: () => Board | null, send: (ops: Op[]) => void, codeSessionChoices: readonly Choice[], close: () => void): HTMLElement[] {
  const codeSessionOptions = [{ value: '', text: 'None' }, ...codeSessionChoices];
  return [
    heading('Board'),
    actionButton('board-settings-close', 'Close', close, 'Close board settings'),
    fieldRow('Caption', textField('board-caption', board.caption ?? '', WHITEBOARD_LIMITS.caption, (caption) => send([{ op: 'board', caption: caption.trim() || null }]))),
    fieldRow('Code session', selectField('board-code-session', codeSessionOptions, board.codeSessionId ?? '', (sessionId) => send([{ op: 'board', codeSessionId: sessionId || null }]))),
    legendEditor(board, () => latestBoard()?.legend ?? null, (legend) => send([{ op: 'board', legend }])),
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

function elementSections(element: BoardElement, latestBoard: () => Board | null, layout: BoardLayout | null, linkState: LinkStateOfBox | null, disclosures: Disclosures, send: (ops: Op[]) => void): HTMLElement[] {
  const set: FieldCommit = (fields) => send([{ op: 'set', id: element.id, fields }]);
  const latest = () => latestBoard()?.elements.get(element.id);
  switch (element.kind) {
    case 'box': return boxSections(element, latest, layout, linkState, disclosures, set);
    case 'wire': return wireSections(element, disclosures, set);
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

function isSameSelection(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  return first.size === second.size && [...first].every((selectedId) => second.has(selectedId));
}

export function createBoardInspector(options: BoardInspectorOptions) {
  const { container } = options;
  container.setAttribute('aria-label', 'Properties');
  const send = (ops: Op[]) => void options.sendOps(ops);
  let paintedSelectedIds: ReadonlySet<string> = new Set();
  let isRepainting = false;
  let isShowingBoardSettings = false;
  const disclosureOpenStates = new Map<DisclosureName, boolean>();
  const disclosures: Disclosures = {
    latchOpenState: (name, hasSetField) => {
      const isOpen = disclosureOpenStates.get(name) ?? hasSetField;
      if (isOpen) disclosureOpenStates.set(name, true);
      return isOpen;
    },
    remember: (name, isOpen) => disclosureOpenStates.set(name, isOpen),
  };

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
    return [...elementSections(element, options.currentBoard, options.layout(), options.linkStateOf(element.id), disclosures, send), openInReviewSection(board, element, options), selectionActionsRow(selected, options)];
  }

  function paint(selectedIds: ReadonlySet<string>): void {
    if (!isSameSelection(selectedIds, paintedSelectedIds)) disclosureOpenStates.clear();
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
