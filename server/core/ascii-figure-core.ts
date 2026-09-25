type Alignment = 'left' | 'right';

interface TableOptions {
  title: string;
  headers?: string[];
  rows: string[][];
  align?: Alignment[];
  terminalColumns?: number;
}

function widthOf(text: string): number {
  return Array.from(text).length;
}

function padToWidth(text: string, width: number, alignment: Alignment): string {
  const paddedLength = text.length + Math.max(0, width - widthOf(text));
  return alignment === 'right' ? text.padStart(paddedLength) : text.padEnd(paddedLength);
}

function splitIntoPhysicalRows(row: string[]): string[][] {
  const linesPerCell = row.map((cell) => cell.split(/\r?\n/));
  const rowHeight = Math.max(1, ...linesPerCell.map((cellLines) => cellLines.length));
  return Array.from({ length: rowHeight }, (_, lineIndex) =>
    linesPerCell.map((cellLines) => cellLines[lineIndex] ?? ''));
}

function renderTable({ title, headers, rows, align, terminalColumns }: TableOptions): string {
  const headerRows = headers ? splitIntoPhysicalRows(headers) : [];
  const bodyRows = rows.flatMap(splitIntoPhysicalRows);
  const allRows = [...headerRows, ...bodyRows];
  const columnCount = Math.max(1, ...allRows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(0, ...allRows.map((row) => widthOf(row[index] ?? ''))));
  const separator = headers ? ' | ' : '  ';
  const renderCells = (row: string[]): string => Array.from({ length: columnCount }, (_, index) =>
    padToWidth(row[index] ?? '', widths[index] ?? 0, align?.[index] ?? (index === 0 || !headers ? 'left' : 'right')),
  ).join(separator);
  const lines = headers
    ? [...headerRows.map(renderCells), widths.map((width) => '-'.repeat(width)).join('-+-'), ...bodyRows.map(renderCells)]
    : bodyRows.map(renderCells);
  const caption = title.trim() ? `[ ${title.trim().toUpperCase()} ]` : '';
  const availableColumns = typeof terminalColumns === 'number' && Number.isFinite(terminalColumns) ? terminalColumns : 80;
  const innerWidth = Math.max(
    0,
    ...lines.map(widthOf),
    caption ? widthOf(caption) + 4 : 0,
    Math.min(48, availableColumns - 4),
  );
  const span = innerWidth + 2;
  const captionLabel = ` ${caption} `;
  const remainingDashes = Math.max(0, span - widthOf(captionLabel));
  const leftDashes = Math.floor(remainingDashes / 2);
  const top = caption
    ? `+${'-'.repeat(leftDashes)}${captionLabel}${'-'.repeat(remainingDashes - leftDashes)}+`
    : `+${'-'.repeat(span)}+`;
  const empty = `| ${' '.repeat(innerWidth)} |`;
  const body = lines.map((line) => `| ${padToWidth(line, innerWidth, 'left')} |`);
  return [top, empty, ...body, empty, `+${'-'.repeat(span)}+`].join('\n');
}

function renderMeterTrack(fraction: number, ticks: number): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * ticks);
  return `[${'='.repeat(filled)}${'-'.repeat(ticks - filled)}]`;
}

export { renderTable, renderMeterTrack };
