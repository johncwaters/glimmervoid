const FRONTMATTER_FENCE = '---';
const FOLDED_SCALAR = /^[>|][+-]?$/;

type SkillFrontmatter = { name: string; description: string };

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  const isQuoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0];
  return isQuoted ? trimmed.slice(1, -1) : trimmed;
}

function frontmatterLines(markdown: string): string[] | null {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return null;
  const closingIndex = lines.indexOf(FRONTMATTER_FENCE, 1);
  if (closingIndex === -1) return null;
  return lines.slice(1, closingIndex);
}

function readFrontmatterValue(lines: string[], key: string): string | null {
  const keyIndex = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (keyIndex === -1) return null;
  const inlineValue = lines[keyIndex].slice(key.length + 1).trim();
  if (!FOLDED_SCALAR.test(inlineValue)) return unquoteYamlScalar(inlineValue);
  const continuation: string[] = [];
  for (const line of lines.slice(keyIndex + 1)) {
    if (!/^\s/.test(line) && line.trim() !== '') break;
    continuation.push(line.trim());
  }
  return continuation.join(' ').trim();
}

function parseSkillFrontmatter(markdown: string): SkillFrontmatter | null {
  const lines = frontmatterLines(markdown);
  if (!lines) return null;
  const name = readFrontmatterValue(lines, 'name');
  if (!name) return null;
  return { name, description: readFrontmatterValue(lines, 'description') ?? '' };
}

function renameSkillFrontmatter(markdown: string, name: string): string {
  const withoutByteOrderMark = markdown.replace(/^﻿/, '');
  const lineBreak = withoutByteOrderMark.includes('\r\n') ? '\r\n' : '\n';
  const nameLine = `name: ${name}`;
  const fencedLines = frontmatterLines(withoutByteOrderMark);
  if (fencedLines === null) return [FRONTMATTER_FENCE, nameLine, FRONTMATTER_FENCE, withoutByteOrderMark].join(lineBreak);
  const bodyLines = withoutByteOrderMark.split(/\r?\n/).slice(fencedLines.length + 2);
  const keptLines = withoutNameEntry(fencedLines);
  return [FRONTMATTER_FENCE, nameLine, ...keptLines, FRONTMATTER_FENCE, ...bodyLines].join(lineBreak);
}

function withoutNameEntry(lines: string[]): string[] {
  const nameIndex = lines.findIndex((line) => line.startsWith('name:'));
  if (nameIndex === -1) return lines;
  const isFolded = FOLDED_SCALAR.test(lines[nameIndex].slice('name:'.length).trim());
  let entryEnd = nameIndex + 1;
  while (isFolded && entryEnd < lines.length && (/^\s/.test(lines[entryEnd]) || lines[entryEnd].trim() === '')) entryEnd += 1;
  return [...lines.slice(0, nameIndex), ...lines.slice(entryEnd)];
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export { SKILL_NAME_PATTERN, parseSkillFrontmatter, renameSkillFrontmatter };
