import type { ColumnRegular, DataType } from '@revolist/revogrid';
import { BOARD_WORKBOOK_MIME } from '#shared/contracts/whiteboard.ts';
import type { BoxMedia } from '#shared/contracts/whiteboard.ts';
import { parseSheetText, serializeEditedSheet, sheetDelimiterOfMime } from '#shared/sheet-csv-core.ts';
import type { ParsedSheet } from '#shared/sheet-csv-core.ts';
import { el } from '../dom-helpers.ts';
import { buildDialogShell } from '../session-card/modal.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';

type SheetSaveOutcome = { ok: true; asset: string } | { ok: false; isConflict: boolean; error: string | null };

interface SheetSource {
  title: string;
  media: () => BoxMedia | null;
  readText: (media: BoxMedia, sheetIndex: number) => Promise<string | null>;
  unsaveableText: () => string | null;
  save: (sheetText: string, loadedAsset: string) => Promise<SheetSaveOutcome>;
}

type SheetGridElement = HTMLElement & {
  source: DataType[];
  columns: ColumnRegular[];
  readonly: boolean;
  range: boolean;
  resize: boolean;
  filter: boolean;
  theme: string;
  hideAttribution: boolean;
  getSource: () => Promise<DataType[]>;
};

const SHEET_UNREAD_TEXT = 'This sheet could not be read.';
const SHEET_GONE_TEXT = 'This sheet is no longer on the board.';
const SHEET_CONFLICT_TEXT = 'The file changed since this sheet opened. Close and open the sheet again to load it; your edits here are not saved.';
const SHEET_UNSAVED_FALLBACK_TEXT = 'The sheet could not be saved.';
const WORKBOOK_READ_ONLY_TEXT = 'An XLSX workbook is read-only on a board.';
const UNSAVED_TEXT = 'Unsaved changes';
const UNSAVED_CLOSE_TEXT = 'Unsaved changes. Save them, or Close again to discard them.';
const DARK_BACKGROUND_LUMINANCE = 0.5;
const ORIGINAL_ROW_INDEX = '__sheetRowIndex';

function columnPropOf(columnIndex: number): string {
  return `c${columnIndex}`;
}

function columnLetterOf(columnIndex: number): string {
  const letter = String.fromCharCode(65 + (columnIndex % 26));
  return columnIndex < 26 ? letter : `${columnLetterOf(Math.floor(columnIndex / 26) - 1)}${letter}`;
}

function columnCountOf(parsed: ParsedSheet): number {
  return parsed.cells.reduce((widest, row) => Math.max(widest, row.length), 0);
}

function columnsOf(parsed: ParsedSheet): ColumnRegular[] {
  const header = parsed.cells[0] ?? [];
  return Array.from({ length: columnCountOf(parsed) }, (_unused, columnIndex) => ({
    prop: columnPropOf(columnIndex),
    name: header[columnIndex] || columnLetterOf(columnIndex),
    sortable: true,
    filter: true,
    size: 160,
  }));
}

function gridRowsOf(parsed: ParsedSheet): DataType[] {
  return parsed.cells.slice(1).map((row, bodyIndex) => {
    const gridRow: DataType = { [ORIGINAL_ROW_INDEX]: bodyIndex + 1 };
    row.forEach((cell, columnIndex) => { gridRow[columnPropOf(columnIndex)] = cell; });
    return gridRow;
  });
}

function cellTextOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function editedRowOf(originalRow: readonly string[], gridRow: DataType, columnCount: number): string[] {
  const editedRow = [...originalRow];
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const cell = cellTextOf(gridRow[columnPropOf(columnIndex)]);
    if (columnIndex < editedRow.length) {
      editedRow[columnIndex] = cell;
      continue;
    }
    if (cell === '') continue;
    while (editedRow.length < columnIndex) editedRow.push('');
    editedRow.push(cell);
  }
  return editedRow;
}

function editedRowsOf(parsed: ParsedSheet, gridRows: readonly DataType[]): string[][] {
  const columnCount = columnCountOf(parsed);
  const gridRowByOriginalIndex = new Map(gridRows.map((gridRow) => [Number(gridRow[ORIGINAL_ROW_INDEX]), gridRow]));
  return parsed.cells.map((originalRow, rowIndex) => {
    const gridRow = gridRowByOriginalIndex.get(rowIndex);
    return gridRow ? editedRowOf(originalRow, gridRow, columnCount) : [...originalRow];
  });
}

function relativeLuminanceOf(cssColor: string): number {
  const channels = cssColor.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) ?? [255, 255, 255];
  const [red = 255, green = 255, blue = 255] = channels;
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}

function gridThemeFor(styleSource: Element): string {
  const background = getComputedStyle(styleSource).backgroundColor;
  return relativeLuminanceOf(background) < DARK_BACKGROUND_LUMINANCE ? 'darkCompact' : 'compact';
}

async function createSheetGrid(parsed: ParsedSheet, isReadOnly: boolean, styleSource: Element): Promise<SheetGridElement> {
  const { defineCustomElements } = await import('@revolist/revogrid/loader');
  defineCustomElements();
  const grid = document.createElement('revo-grid') as SheetGridElement;
  grid.classList.add('wb-sheet-grid');
  Object.assign(grid, { theme: gridThemeFor(styleSource), range: true, resize: true, filter: true, readonly: isReadOnly, hideAttribution: true, columns: columnsOf(parsed), source: gridRowsOf(parsed) });
  return grid;
}

export function openSheetEditor(source: SheetSource): void {
  const { overlay, dialog, close, actions, btnCancel } = buildDialogShell({ title: source.title, dialogClass: 'dialog wb-sheet-editor', cancelLabel: 'Close', closeOnBackdrop: false, onEscape: () => closeCellEditOrDialog() });
  const body = el('div', 'wb-sheet-editor-body');
  const statusText = el('span', 'wb-sheet-editor-status');
  statusText.setAttribute('role', 'status');
  const saveButton = button({ variant: 'primary', label: 'Save', action: 'save-sheet' });
  saveButton.disabled = true;
  actions.prepend(statusText);
  actions.append(saveButton);
  const sheetTabs = el('div', 'wb-sheet-editor-tabs');
  sheetTabs.setAttribute('role', 'tablist');
  sheetTabs.hidden = true;
  dialog.append(sheetTabs, body, actions);
  let latestSheetIndex = 0;
  let unsavedEditCount = 0;
  let isClosePending = false;
  let isSaving = false;
  let loaded: { parsed: ParsedSheet; asset: string; grid: SheetGridElement } | null = null;

  const showStatus = (text: string) => { statusText.textContent = text; };
  const refreshSaveButton = () => { saveButton.disabled = isSaving || unsavedEditCount === 0 || source.unsaveableText() !== null; };

  function requestClose(): void {
    if (unsavedEditCount === 0 || isClosePending) {
      close();
      return;
    }
    isClosePending = true;
    showStatus(UNSAVED_CLOSE_TEXT);
  }
  function closeCellEditOrDialog(): void {
    const openCellEditor = loaded?.grid.querySelector('revogr-edit');
    if (!openCellEditor) {
      requestClose();
      return;
    }
    openCellEditor.dispatchEvent(new CustomEvent('closeedit', { bubbles: true, detail: false }));
  }
  btnCancel.addEventListener('click', requestClose);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) requestClose();
  });

  const save = async () => {
    if (!loaded || unsavedEditCount === 0) return;
    isSaving = true;
    refreshSaveButton();
    const gridRows = await loaded.grid.getSource();
    const sheetText = serializeEditedSheet(loaded.parsed, editedRowsOf(loaded.parsed, gridRows));
    const outcome = await source.save(sheetText, loaded.asset);
    isSaving = false;
    if (!outcome.ok) {
      showStatus(outcome.isConflict ? SHEET_CONFLICT_TEXT : (outcome.error ?? SHEET_UNSAVED_FALLBACK_TEXT));
      refreshSaveButton();
      return;
    }
    loaded = { ...loaded, parsed: parseSheetText(sheetText, loaded.parsed.delimiter), asset: outcome.asset };
    unsavedEditCount = 0;
    isClosePending = false;
    showStatus('Saved');
    refreshSaveButton();
  };
  saveButton.addEventListener('click', () => { void save(); });

  async function showSheet(media: BoxMedia, sheetIndex: number): Promise<void> {
    latestSheetIndex = sheetIndex;
    const sheetText = await source.readText(media, sheetIndex);
    if (latestSheetIndex !== sheetIndex) return;
    if (sheetText === null) {
      showStatus(SHEET_UNREAD_TEXT);
      return;
    }
    const parsed = parseSheetText(sheetText, sheetDelimiterOfMime(media.mime));
    const readOnlyText = media.mime === BOARD_WORKBOOK_MIME ? WORKBOOK_READ_ONLY_TEXT : source.unsaveableText();
    const grid = await createSheetGrid(parsed, readOnlyText !== null, dialog);
    if (latestSheetIndex !== sheetIndex) return;
    grid.addEventListener('afteredit', () => {
      unsavedEditCount += 1;
      isClosePending = false;
      showStatus(UNSAVED_TEXT);
      refreshSaveButton();
    });
    body.replaceChildren(grid);
    loaded = { parsed, asset: media.asset, grid };
    showStatus(readOnlyText ?? '');
  }

  function showWorkbookTabs(media: BoxMedia): void {
    if (media.mime !== BOARD_WORKBOOK_MIME) return;
    saveButton.hidden = true;
    sheetTabs.hidden = false;
    const tabs = media.sheets.map((sheetName, sheetIndex) => {
      const tab = createPressable('header-tab', sheetName);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(sheetIndex === 0));
      tab.addEventListener('click', () => {
        for (const [otherIndex, otherTab] of tabs.entries()) otherTab.setAttribute('aria-selected', String(otherIndex === sheetIndex));
        void showSheet(media, sheetIndex);
      });
      return tab;
    });
    sheetTabs.replaceChildren(...tabs);
  }

  const media = source.media();
  if (!media) {
    showStatus(SHEET_GONE_TEXT);
    return;
  }
  showWorkbookTabs(media);
  void showSheet(media, 0);
}

export type { SheetSaveOutcome };
