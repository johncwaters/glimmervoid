import { NOTE_TONE_HEX, NOTE_TONES, TEXT_SIZES, WIRE_ARROWS, WIRE_ROUTES, WIRE_TONES, WIRE_WIDTHS } from '#shared/contracts/whiteboard.ts';
import type { Board, Box, NoteTone, Op, TextSize, Wire } from '#shared/contracts/whiteboard.ts';
import { SHAPE_TRAITS } from '#shared/whiteboard-shapes.ts';
import { el } from '../dom-helpers.ts';
import { createSvgIcon, createSvgShape } from '../svg-dom.ts';
import { actionButton, pickButton, pickGroup, WIRE_TONE_LABELS } from './board-inspect.ts';

interface StylePopoverOptions {
  host: HTMLElement;
  currentBoard: () => Board | null;
  sendOps: (ops: Op[]) => Promise<boolean>;
}

interface StyledSelection {
  tintedBoxes: Box[];
  sizedBoxes: Box[];
  wires: Wire[];
}

const SWATCH_SIZE_PX = 16;
const NOTE_TONE_LABELS: Readonly<Record<NoteTone, string>> = { yellow: 'Yellow', pink: 'Pink', green: 'Green', blue: 'Blue', violet: 'Violet' };
const WIRE_WIDTH_LABELS: Readonly<Record<Wire['width'], string>> = { thin: 'Thin', bold: 'Bold' };
const WIRE_ROUTE_LABELS: Readonly<Record<Wire['route'], string>> = { elbow: 'Elbow', sharp: 'Sharp', curved: 'Curved' };
const WIRE_ARROW_LABELS: Readonly<Record<Wire['arrows'], string>> = { none: 'None', end: 'End', both: 'Both' };
const WIRE_ARROW_NAMES: Readonly<Record<Wire['arrows'], string>> = { none: 'No arrowheads', end: 'Arrowhead at the end', both: 'Arrowheads at both ends' };
const TEXT_SIZE_NAMES: Readonly<Record<TextSize, string>> = { S: 'Small', M: 'Medium', L: 'Large' };

function toneSwatch(tone: NoteTone): SVGSVGElement {
  const swatch = createSvgIcon(SWATCH_SIZE_PX, SWATCH_SIZE_PX);
  swatch.append(createSvgShape('circle', { cx: '8', cy: '8', r: '6.5', fill: NOTE_TONE_HEX[tone] }));
  return swatch;
}

function styledSelectionOf(board: Board, selectedIds: ReadonlySet<string>): StyledSelection {
  const selected = [...selectedIds].flatMap((selectedId) => board.elements.get(selectedId) ?? []);
  const boxes = selected.filter((element): element is Box => element.kind === 'box');
  return {
    tintedBoxes: boxes.filter((box) => SHAPE_TRAITS[box.shape].takesTone),
    sizedBoxes: boxes.filter((box) => box.shape !== 'device'),
    wires: selected.filter((element): element is Wire => element.kind === 'wire'),
  };
}

function sharedValueOf<Styled, Value>(elements: readonly Styled[], styleOf: (element: Styled) => Value): Value | undefined {
  const values = new Set(elements.map(styleOf));
  return values.size === 1 ? [...values][0] : undefined;
}

function pressedTextButton(field: string, label: string, isPressed: boolean, onPick: () => void, accessibleName?: string): HTMLButtonElement {
  const pick = actionButton(field, label, () => {
    if (!isPressed) onPick();
  }, accessibleName);
  pick.setAttribute('aria-pressed', String(isPressed));
  return pick;
}

function styleRow(label: string, group: HTMLElement): HTMLElement {
  const row = el('div', 'wb-style-row');
  row.append(el('span', 'wb-style-label', label), group);
  return row;
}

export function createBoardStylePopover(options: StylePopoverOptions) {
  const { host } = options;
  const island = el('div', 'wb-island wb-style-popover');
  island.setAttribute('role', 'group');
  island.setAttribute('aria-label', 'Style');
  island.hidden = true;
  host.prepend(island);

  function restyle<Styled extends Box | Wire>(elements: readonly Styled[], isAlreadyStyled: (element: Styled) => boolean, fields: Record<string, string | null>): void {
    const ops: Op[] = elements.filter((element) => !isAlreadyStyled(element)).map((element) => ({ op: 'set', id: element.id, fields }));
    if (ops.length > 0) void options.sendOps(ops);
  }

  function fillRow(boxes: readonly Box[]): HTMLElement {
    const tone = sharedValueOf(boxes, (box) => box.tone);
    const fill = (choice: NoteTone | null) => restyle(boxes, (box) => box.tone === choice, { tone: choice });
    const swatches = NOTE_TONES.map((choice) => pickButton(`fill-${choice}`, NOTE_TONE_LABELS[choice], toneSwatch(choice), choice === tone, () => fill(choice)));
    const noFill = pressedTextButton('fill-none', 'None', tone === null, () => fill(null), 'No fill');
    return styleRow('Fill', pickGroup('Fill', 'wb-inspect-tones', [...swatches, noFill]));
  }

  function textSizeRow(boxes: readonly Box[]): HTMLElement {
    const textSize = sharedValueOf(boxes, (box) => box.textSize);
    const picks = TEXT_SIZES.map((choice) => pressedTextButton(`text-size-${choice}`, choice, choice === textSize, () => restyle(boxes, (box) => box.textSize === choice, { textSize: choice }), TEXT_SIZE_NAMES[choice]));
    return styleRow('Size', pickGroup('Text size', 'wb-style-picks', picks));
  }

  function wireRows(wires: readonly Wire[]): HTMLElement[] {
    const tone = sharedValueOf(wires, (wire) => wire.tone);
    const width = sharedValueOf(wires, (wire) => wire.width);
    const route = sharedValueOf(wires, (wire) => wire.route);
    const arrows = sharedValueOf(wires, (wire) => wire.arrows);
    const tonePicks = WIRE_TONES.map((choice) => pressedTextButton(`wire-tone-${choice}`, WIRE_TONE_LABELS[choice], choice === tone, () => restyle(wires, (wire) => wire.tone === choice, { tone: choice })));
    const widthPicks = WIRE_WIDTHS.map((choice) => pressedTextButton(`wire-width-${choice}`, WIRE_WIDTH_LABELS[choice], choice === width, () => restyle(wires, (wire) => wire.width === choice, { width: choice })));
    const routePicks = WIRE_ROUTES.map((choice) => pressedTextButton(`wire-route-${choice}`, WIRE_ROUTE_LABELS[choice], choice === route, () => restyle(wires, (wire) => wire.route === choice, { route: choice })));
    const arrowPicks = WIRE_ARROWS.map((choice) => pressedTextButton(`wire-arrows-${choice}`, WIRE_ARROW_LABELS[choice], choice === arrows, () => restyle(wires, (wire) => wire.arrows === choice, { arrows: choice }), WIRE_ARROW_NAMES[choice]));
    return [
      styleRow('Wire', pickGroup('Wire tone', 'wb-style-picks', tonePicks)),
      styleRow('Width', pickGroup('Wire width', 'wb-style-picks', widthPicks)),
      styleRow('Route', pickGroup('Wire route', 'wb-style-picks', routePicks)),
      styleRow('Arrows', pickGroup('Arrowheads', 'wb-style-picks', arrowPicks)),
    ];
  }

  function paint(selectedIds: ReadonlySet<string>): void {
    const board = options.currentBoard();
    const selection = board ? styledSelectionOf(board, selectedIds) : { tintedBoxes: [], sizedBoxes: [], wires: [] };
    const rows = [
      ...(selection.tintedBoxes.length > 0 ? [fillRow(selection.tintedBoxes)] : []),
      ...(selection.sizedBoxes.length > 0 ? [textSizeRow(selection.sizedBoxes)] : []),
      ...(selection.wires.length > 0 ? wireRows(selection.wires) : []),
    ];
    const active = document.activeElement;
    const focusedField = active instanceof HTMLElement && island.contains(active) ? active.dataset.field : undefined;
    island.replaceChildren(...rows);
    island.hidden = rows.length === 0;
    if (focusedField) island.querySelector<HTMLElement>(`[data-field="${CSS.escape(focusedField)}"]`)?.focus();
  }

  return { paint };
}

export type BoardStylePopover = ReturnType<typeof createBoardStylePopover>;
