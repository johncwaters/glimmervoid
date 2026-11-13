export const LONG_PRESS_MS = 500;

const PROMPT_SCAN_LIMIT = 512;

const BOX_VERTICAL = String.fromCharCode(0x2502);
const HEAVY_RIGHT_ANGLE = String.fromCharCode(0x276f);
const SINGLE_RIGHT_ANGLE = String.fromCharCode(0x203a);
const NOT_PROMPT_WORD = `[^\\s${BOX_VERTICAL}|]`;
const PROMPT_LINE = new RegExp(`^[\\s${BOX_VERTICAL}|]*(?:[$%${HEAVY_RIGHT_ANGLE}${SINGLE_RIGHT_ANGLE}](?:\\s|$)|${NOT_PROMPT_WORD}*[@:~/]${NOT_PROMPT_WORD}*[$#%](?:\\s|$))`);

export interface BufferRow {
  text: string;
  isWrapped: boolean;
}

export function joinWrappedRows(rows: readonly BufferRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += row.text;
      continue;
    }
    lines.push(row.text);
  }
  return lines.map((line) => line.trimEnd());
}

function withoutBlankEdges(lines: readonly string[]): string[] {
  let first = 0;
  let last = lines.length - 1;
  while (first <= last && lines[first].trim() === '') first++;
  while (last >= first && lines[last].trim() === '') last--;
  return lines.slice(first, last + 1);
}

function isPromptLine(line: string): boolean {
  return PROMPT_LINE.test(line.slice(0, PROMPT_SCAN_LIMIT));
}

export function lastOutputText(lines: readonly string[]): string {
  const promptIndexes = lines.flatMap((line, index) => (isPromptLine(line) ? [index] : []));
  const currentPromptIndex = promptIndexes.at(-1) ?? lines.length;
  const previousPromptIndex = promptIndexes.at(-2) ?? -1;
  return withoutBlankEdges(lines.slice(previousPromptIndex + 1, currentPromptIndex)).join('\n');
}
