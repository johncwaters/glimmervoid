type SheetDelimiter = ',' | '\t';

interface ParsedSheet {
  byteOrderMark: string;
  text: string;
  delimiter: SheetDelimiter;
  lineEnding: '\n' | '\r\n';
  recordStarts: Uint32Array;
  recordEnds: Uint32Array;
  cells: string[][];
}

const QUOTE = '"';
const CARRIAGE_RETURN = '\r';
const LINE_FEED = '\n';
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const QUOTED_EMPTY_CELL = QUOTE + QUOTE;
const SHEET_DELIMITER_BY_MIME: Readonly<Record<string, SheetDelimiter>> = { 'text/csv': ',', 'text/tab-separated-values': '\t' };

function sheetDelimiterOfMime(mime: string): SheetDelimiter {
  return SHEET_DELIMITER_BY_MIME[mime] ?? ',';
}

function lineEndingOf(text: string): '\n' | '\r\n' {
  const firstLineFeed = text.indexOf(LINE_FEED);
  return firstLineFeed > 0 && text[firstLineFeed - 1] === CARRIAGE_RETURN ? '\r\n' : '\n';
}

interface RecordScan {
  cells: string[];
  contentEnd: number;
  nextStart: number;
}

function scanQuotedCell(text: string, openingQuoteAt: number): { value: string; afterClosingQuote: number } {
  let value = '';
  let cursor = openingQuoteAt + 1;
  while (cursor < text.length) {
    const closingQuoteAt = text.indexOf(QUOTE, cursor);
    if (closingQuoteAt === -1) return { value: value + text.slice(cursor), afterClosingQuote: text.length };
    value += text.slice(cursor, closingQuoteAt);
    if (text[closingQuoteAt + 1] !== QUOTE) return { value, afterClosingQuote: closingQuoteAt + 1 };
    value += QUOTE;
    cursor = closingQuoteAt + 2;
  }
  return { value, afterClosingQuote: text.length };
}

function lineBreakLengthAt(text: string, position: number): number {
  if (text[position] === LINE_FEED) return 1;
  if (text[position] === CARRIAGE_RETURN) return text[position + 1] === LINE_FEED ? 2 : 1;
  return 0;
}

function scanRecord(text: string, start: number, delimiter: SheetDelimiter): RecordScan {
  const cells: string[] = [];
  let cursor = start;
  let cell = '';
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === QUOTE && cell === '') {
      const quoted = scanQuotedCell(text, cursor);
      cell = quoted.value;
      cursor = quoted.afterClosingQuote;
      continue;
    }
    if (character === delimiter) {
      cells.push(cell);
      cell = '';
      cursor += 1;
      continue;
    }
    const lineBreakLength = lineBreakLengthAt(text, cursor);
    if (lineBreakLength > 0) {
      cells.push(cell);
      return { cells, contentEnd: cursor, nextStart: cursor + lineBreakLength };
    }
    cell += character;
    cursor += 1;
  }
  cells.push(cell);
  return { cells, contentEnd: text.length, nextStart: text.length };
}

function parseSheetText(sourceText: string, delimiter: SheetDelimiter, maxRecords = Number.POSITIVE_INFINITY): ParsedSheet {
  const byteOrderMark = sourceText.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : '';
  const text = sourceText.slice(byteOrderMark.length);
  const starts: number[] = [];
  const ends: number[] = [];
  const cells: string[][] = [];
  let cursor = 0;
  while (cursor < text.length && cells.length < maxRecords) {
    const scanned = scanRecord(text, cursor, delimiter);
    starts.push(cursor);
    ends.push(scanned.contentEnd);
    cells.push(scanned.cells);
    cursor = scanned.nextStart;
  }
  return { byteOrderMark, text, delimiter, lineEnding: lineEndingOf(text), recordStarts: Uint32Array.from(starts), recordEnds: Uint32Array.from(ends), cells };
}

function cellNeedsQuotes(cell: string, delimiter: SheetDelimiter): boolean {
  return cell.includes(delimiter) || cell.includes(QUOTE) || cell.includes(LINE_FEED) || cell.includes(CARRIAGE_RETURN);
}

function serializedCell(cell: string, delimiter: SheetDelimiter): string {
  if (!cellNeedsQuotes(cell, delimiter)) return cell;
  return `${QUOTE}${cell.replaceAll(QUOTE, QUOTE + QUOTE)}${QUOTE}`;
}

function serializedRecord(cells: readonly string[], delimiter: SheetDelimiter): string {
  if (cells.length === 1 && cells[0] === '') return QUOTED_EMPTY_CELL;
  return cells.map((cell) => serializedCell(cell, delimiter)).join(delimiter);
}

function isSameRecord(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((cell, index) => cell === right[index]);
}

function recordTextOf(original: ParsedSheet, editedRows: readonly (readonly string[])[], rowIndex: number): string {
  const editedRow = editedRows[rowIndex] ?? [];
  const originalRow = original.cells[rowIndex];
  if (originalRow && isSameRecord(originalRow, editedRow)) return original.text.slice(original.recordStarts[rowIndex], original.recordEnds[rowIndex]);
  return serializedRecord(editedRow, original.delimiter);
}

function separatorAfter(original: ParsedSheet, rowIndex: number, isLastRow: boolean): string {
  const isOriginalRecord = rowIndex < original.cells.length;
  if (!isOriginalRecord) return isLastRow && !hasTrailingLineBreak(original) ? '' : original.lineEnding;
  const separator = original.text.slice(original.recordEnds[rowIndex], (original.recordStarts[rowIndex + 1] ?? original.text.length));
  if (separator !== '' || isLastRow) return separator;
  return original.lineEnding;
}

function hasTrailingLineBreak(original: ParsedSheet): boolean {
  return original.text.endsWith(LINE_FEED) || original.text.endsWith(CARRIAGE_RETURN);
}

function serializeEditedSheet(original: ParsedSheet, editedRows: readonly (readonly string[])[]): string {
  const parts: string[] = [original.byteOrderMark];
  for (let rowIndex = 0; rowIndex < editedRows.length; rowIndex += 1) {
    parts.push(recordTextOf(original, editedRows, rowIndex), separatorAfter(original, rowIndex, rowIndex === editedRows.length - 1));
  }
  return parts.join('');
}

export { parseSheetText, serializeEditedSheet, sheetDelimiterOfMime };
export type { ParsedSheet, SheetDelimiter };
