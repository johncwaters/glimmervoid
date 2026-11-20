import { isShellTool } from './chat-activity-core.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import type { PlanInline } from '../plan/plan-markdown-core.ts';

export type TurnSegment = { kind: 'text'; text: string } | { kind: 'tools'; labels: string[]; callCount: number };

export interface FileEdit {
  path: string;
  added: number;
  removed: number;
  hasLineCounts: boolean;
}

export interface FileEditTally {
  fileCount: number;
  added: number;
  removed: number;
  hasLineCounts: boolean;
}

interface TurnDigest {
  asked: string | null;
  isFoldable: boolean;
}

const PATH_FIELDS = ['file_path', 'filePath', 'path', 'TargetFile', 'notebook_path', 'AbsolutePath', 'Path'] as const;
const ARGUMENT_FIELDS = ['description', 'command', 'CommandLine', 'cmd', 'pattern', 'query', 'url', 'Url', 'prompt'] as const;
const LEADING_CD = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/;
const OLD_NEW_FIELD_PAIRS = [
  ['old_string', 'new_string'],
  ['oldString', 'newString'],
  ['oldText', 'newText'],
  ['TargetContent', 'ReplacementContent'],
] as const;
const WHOLE_FILE_FIELDS = ['content', 'CodeContent', 'new_source'] as const;
const EDIT_LIST_FIELDS = ['edits', 'ReplacementChunks'] as const;
const CUT_PATH_FIELD = /"(file_path|filePath|path|TargetFile)"\s*:\s*"((?:[^"\\]|\\.)+)"/;
const CUT_CODEX_CHANGE_PATH = /"changes"\s*:\s*\{\s*"((?:[^"\\]|\\.)+)"/;

function inlineText(inlines: readonly PlanInline[]): string {
  return inlines.map((inline) => ('children' in inline ? inlineText(inline.children) : inline.text)).join('');
}

function normalizedSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function textsOf(segments: readonly TurnSegment[]): string[] {
  return segments.flatMap((segment) => (segment.kind === 'text' && segment.text.trim().length > 0 ? [segment.text] : []));
}

function askedOf(finalText: string): string | null {
  const lastBlock = parsePlanMarkdown(finalText).at(-1);
  if (lastBlock?.type !== 'paragraph') return null;
  const paragraph = normalizedSpace(inlineText(lastBlock.children));
  return paragraph.endsWith('?') ? paragraph : null;
}

const MAX_INTERIM_REPLY_CHARS = 60;

function hasLink(inlines: readonly PlanInline[]): boolean {
  return inlines.some((inline) => inline.type === 'link' || ('children' in inline && hasLink(inline.children)));
}

export function interimReplyText(text: string): string | null {
  const trimmedText = text.trim();
  if (trimmedText.length > MAX_INTERIM_REPLY_CHARS || trimmedText.includes('\n')) return null;
  const blocks = parsePlanMarkdown(trimmedText);
  const onlyBlock = blocks[0];
  if (blocks.length !== 1 || onlyBlock?.type !== 'paragraph' || hasLink(onlyBlock.children)) return null;
  return normalizedSpace(inlineText(onlyBlock.children));
}

export function isInterimReply(text: string): boolean {
  return interimReplyText(text) !== null;
}

export function digestTurn(segments: readonly TurnSegment[], toolCount: number): TurnDigest {
  const texts = textsOf(segments);
  const finalText = texts.at(-1);
  return { asked: finalText === undefined ? null : askedOf(finalText), isFoldable: toolCount > 0 || texts.length > 1 };
}

function stringField(input: unknown, field: string): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value: unknown = Reflect.get(input, field);
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function firstStringField(input: unknown, fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = stringField(input, field);
    if (value !== null) return value;
  }
  return null;
}

function shownPathOf(path: string, workingDirectory: string | null): string {
  if (workingDirectory === null) return path;
  const prefix = workingDirectory.endsWith('/') ? workingDirectory : `${workingDirectory}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function firstLineOf(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function shortArgumentOf(argument: string, workingDirectory: string | null): string {
  const argumentLine = firstLineOf(argument);
  const withoutCd = argumentLine.replace(LEADING_CD, '');
  const shownArgument = withoutCd.length > 0 ? withoutCd : argumentLine;
  if (workingDirectory === null) return shownArgument;
  const prefix = workingDirectory.endsWith('/') ? workingDirectory : `${workingDirectory}/`;
  const leadingPrefix = new RegExp(`(^|[\\s"'=])${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  return shownArgument.replace(leadingPrefix, '$1');
}

export function toolLabelOf(name: string, input: unknown, workingDirectory: string | null): string {
  const path = firstStringField(input, PATH_FIELDS);
  if (path !== null) return `${name} ${shownPathOf(path, workingDirectory)}`;
  const argument = firstStringField(input, ARGUMENT_FIELDS);
  if (argument === null) return name;
  const shownArgument = shortArgumentOf(argument, workingDirectory);
  if (isShellTool(name)) return shownArgument;
  return `${name} ${shownArgument}`;
}

function lineCountOf(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

function lineDiffOf(oldText: string, newText: string): { added: number; removed: number } {
  const oldLines = oldText.length === 0 ? [] : oldText.split('\n');
  const newLines = newText.length === 0 ? [] : newText.split('\n');
  const unmatchedOldCountByLine = new Map<string, number>();
  for (const line of oldLines) unmatchedOldCountByLine.set(line, (unmatchedOldCountByLine.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of newLines) {
    const unmatchedCount = unmatchedOldCountByLine.get(line) ?? 0;
    if (unmatchedCount > 0) {
      unmatchedOldCountByLine.set(line, unmatchedCount - 1);
      continue;
    }
    added += 1;
  }
  const removed = [...unmatchedOldCountByLine.values()].reduce((total, count) => total + count, 0);
  return { added, removed };
}

function oldNewDiffOf(input: unknown): { added: number; removed: number } | null {
  for (const [oldField, newField] of OLD_NEW_FIELD_PAIRS) {
    if (typeof input !== 'object' || input === null || !(oldField in input) || !(newField in input)) continue;
    const oldText: unknown = Reflect.get(input, oldField);
    const newText: unknown = Reflect.get(input, newField);
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null;
    return lineDiffOf(oldText, newText);
  }
  return null;
}

function editListDiffOf(input: unknown): { added: number; removed: number } | null {
  for (const field of EDIT_LIST_FIELDS) {
    if (typeof input !== 'object' || input === null) return null;
    const edits: unknown = Reflect.get(input, field);
    if (!Array.isArray(edits)) continue;
    const diffs = edits.map(oldNewDiffOf).filter((diff) => diff !== null);
    return { added: diffs.reduce((total, diff) => total + diff.added, 0), removed: diffs.reduce((total, diff) => total + diff.removed, 0) };
  }
  return null;
}

function unifiedDiffCountsOf(diff: string): { added: number; removed: number } {
  const lines = diff.split('\n').filter((line) => !line.startsWith('+++') && !line.startsWith('---'));
  return { added: lines.filter((line) => line.startsWith('+')).length, removed: lines.filter((line) => line.startsWith('-')).length };
}

function codexChangeEditOf(path: string, change: unknown, workingDirectory: string | null): FileEdit {
  const shownPath = shownPathOf(path, workingDirectory);
  const unifiedDiff = stringField(change, 'unified_diff');
  if (unifiedDiff !== null) return { path: shownPath, ...unifiedDiffCountsOf(unifiedDiff), hasLineCounts: true };
  const content = stringField(change, 'content') ?? '';
  const changeType = stringField(change, 'type');
  if (changeType === 'add') return { path: shownPath, added: lineCountOf(content), removed: 0, hasLineCounts: true };
  if (changeType === 'delete') return { path: shownPath, added: 0, removed: lineCountOf(content), hasLineCounts: true };
  return { path: shownPath, added: 0, removed: 0, hasLineCounts: false };
}

function codexPatchEditsOf(input: unknown, workingDirectory: string | null): FileEdit[] | null {
  if (typeof input !== 'object' || input === null) return null;
  const changes: unknown = Reflect.get(input, 'changes');
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) return null;
  return Object.entries(changes).map(([path, change]) => codexChangeEditOf(path, change, workingDirectory));
}

export function fileEditsOf(input: unknown, workingDirectory: string | null): FileEdit[] {
  const codexEdits = codexPatchEditsOf(input, workingDirectory);
  if (codexEdits !== null) return codexEdits;
  const path = firstStringField(input, PATH_FIELDS);
  if (path === null) return [];
  const shownPath = shownPathOf(path, workingDirectory);
  const diff = oldNewDiffOf(input) ?? editListDiffOf(input);
  if (diff !== null) return [{ path: shownPath, ...diff, hasLineCounts: true }];
  const wholeFile = firstStringField(input, WHOLE_FILE_FIELDS);
  if (wholeFile !== null) return [{ path: shownPath, added: lineCountOf(wholeFile), removed: 0, hasLineCounts: true }];
  return [{ path: shownPath, added: 0, removed: 0, hasLineCounts: false }];
}

export function truncatedFileEditsOf(input: unknown, workingDirectory: string | null): FileEdit[] {
  const cutJson = typeof input === 'string' ? input : JSON.stringify(input) ?? '';
  const path = CUT_PATH_FIELD.exec(cutJson)?.[2] ?? CUT_CODEX_CHANGE_PATH.exec(cutJson)?.[1] ?? null;
  if (path === null) return [{ path: '', added: 0, removed: 0, hasLineCounts: false }];
  return [{ path: shownPathOf(path, workingDirectory), added: 0, removed: 0, hasLineCounts: false }];
}
