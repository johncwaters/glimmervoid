import { parseEnv } from 'node:util';

const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const QUOTE_PREFERENCE = ["'", '"', '`'] as const;
const QUOTES: readonly string[] = QUOTE_PREFERENCE;

interface EnvSpan {
  name: string | null;
  lines: string[];
}

function envLineOrNull(name: string, value: string): string | null {
  for (const quote of QUOTE_PREFERENCE) {
    if (value.includes(quote)) continue;
    const line = `${name}=${quote}${value}${quote}`;
    if (parseEnv(line)[name] === value) return line;
  }
  return null;
}

function unwritableEnvNames(valuesByName: Readonly<Record<string, string>>): string[] {
  return Object.entries(valuesByName).filter(([name, value]) => envLineOrNull(name, value) === null).map(([name]) => name);
}

function closingLineIndexOf(lines: readonly string[], firstLineIndex: number, quote: string): number {
  for (let lineIndex = firstLineIndex + 1; lineIndex < lines.length; lineIndex++) {
    if (lines[lineIndex]?.includes(quote)) return lineIndex;
  }
  return -1;
}

function openingQuoteOf(valueStart: string): string | null {
  const quote = valueStart[0];
  if (quote === undefined || !QUOTES.includes(quote)) return null;
  return valueStart.indexOf(quote, 1) === -1 ? quote : null;
}

function envSpansOf(lines: readonly string[]): EnvSpan[] {
  const spans: EnvSpan[] = [];
  const quotesWithNoLaterLine = new Set<string>();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? '';
    const assignment = ENV_ASSIGNMENT.exec(line);
    if (assignment === null) {
      spans.push({ name: null, lines: [line] });
      continue;
    }
    const name = assignment[1] ?? null;
    const openingQuote = openingQuoteOf(line.slice(assignment[0].length).trimStart());
    const closingLineIndex = openingQuote === null || quotesWithNoLaterLine.has(openingQuote) ? -1 : closingLineIndexOf(lines, lineIndex, openingQuote);
    if (closingLineIndex === -1) {
      if (openingQuote !== null) quotesWithNoLaterLine.add(openingQuote);
      spans.push({ name, lines: [line] });
      continue;
    }
    spans.push({ name, lines: lines.slice(lineIndex, closingLineIndex + 1) });
    lineIndex = closingLineIndex;
  }
  return spans;
}

function upsertEnvLines(existingText: string, valuesByName: Readonly<Record<string, string>>): string {
  const lineByName = new Map<string, string>();
  for (const [name, value] of Object.entries(valuesByName)) {
    const line = envLineOrNull(name, value);
    if (line !== null) lineByName.set(name, line);
  }
  const replacedNames = new Set<string>();
  const lines = existingText === '' ? [] : existingText.replace(/\n$/, '').split('\n');
  const updatedLines = envSpansOf(lines).flatMap((span) => {
    const replacement = span.name === null ? undefined : lineByName.get(span.name);
    if (span.name === null || replacement === undefined) return span.lines;
    replacedNames.add(span.name);
    return [replacement];
  });
  const appendedLines = [...lineByName].filter(([name]) => !replacedNames.has(name)).map(([, line]) => line);
  return `${[...updatedLines, ...appendedLines].join('\n')}\n`;
}

export { unwritableEnvNames, upsertEnvLines };
