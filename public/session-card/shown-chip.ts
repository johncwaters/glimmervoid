import type { IMarker, Terminal } from '@xterm/xterm';
import type { ShownFile } from '#shared/contracts/session.ts';
import { el } from '../dom-helpers.ts';
import { openShownLightbox, shownThumbnailUrl } from '../shown-files.ts';
import { findSessionUi } from './card-registry.ts';

const CHIP_WIDTH_CELLS = 22;
const KIND_LABELS: Record<ShownFile['kind'], string> = { image: 'Image', video: 'Video', page: 'Page' };

interface ChipLine {
  marker: IMarker;
  chipCount: number;
}

const chipLineByTerminal = new WeakMap<Terminal, ChipLine>();

function chipLineFor(term: Terminal): ChipLine | null {
  const cursorMarker = term.registerMarker(0);
  if (!cursorMarker) return null;
  const previousLine = chipLineByTerminal.get(term);
  if (previousLine && !previousLine.marker.isDisposed && previousLine.marker.line === cursorMarker.line) {
    cursorMarker.dispose();
    return previousLine;
  }
  const freshLine = { marker: cursorMarker, chipCount: 0 };
  chipLineByTerminal.set(term, freshLine);
  return freshLine;
}

function buildChipContent(sessionId: string, file: ShownFile): HTMLButtonElement {
  const chip = el('button', 'shown-chip');
  chip.type = 'button';
  chip.title = file.caption ?? file.pageTitle ?? file.name;
  chip.setAttribute('aria-label', `Open ${file.name}`);
  const thumbnailUrl = shownThumbnailUrl(sessionId, file);
  if (thumbnailUrl) {
    const thumbnail = el('img', 'shown-chip-thumb');
    thumbnail.src = thumbnailUrl;
    thumbnail.alt = '';
    thumbnail.decoding = 'async';
    chip.append(thumbnail);
  }
  if (!thumbnailUrl) chip.append(el('span', 'shown-chip-kind', KIND_LABELS[file.kind]));
  chip.append(el('span', 'shown-chip-name', file.pageTitle ?? file.name));
  chip.addEventListener('click', (event) => {
    event.stopPropagation();
    openShownLightbox(sessionId, file.id);
  });
  return chip;
}

function placeChip(term: Terminal, sessionId: string, file: ShownFile): void {
  const chipLine = chipLineFor(term);
  if (!chipLine) return;
  const decoration = term.registerDecoration({
    marker: chipLine.marker,
    anchor: 'right',
    x: chipLine.chipCount * CHIP_WIDTH_CELLS,
    width: CHIP_WIDTH_CELLS,
    layer: 'top',
  });
  if (!decoration) return;
  chipLine.chipCount += 1;
  const chip = buildChipContent(sessionId, file);
  decoration.onRender((element) => {
    if (!element.contains(chip)) element.replaceChildren(chip);
    element.classList.add('shown-chip-slot');
  });
}

export function placeShownChips(sessionId: string, arrivedFiles: readonly ShownFile[]): void {
  const term = findSessionUi(sessionId)?.term;
  if (!term) return;
  for (const file of arrivedFiles) placeChip(term, sessionId, file);
}
