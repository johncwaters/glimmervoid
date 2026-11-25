import type { AnsweredQuestion } from '#shared/contracts/trace.ts';
import { isShellTool } from './chat-activity-core.ts';
import { parsePlanMarkdown } from '../plan/plan-markdown-core.ts';
import type { PlanInline } from '../plan/plan-markdown-core.ts';
import { EDIT_LIST_FIELDS, OLD_NEW_FIELD_PAIRS, PATH_FIELDS, WHOLE_FILE_FIELDS, firstStringField, shownPathOf, stringField } from '#shared/file-edits-core.ts';
import type { FileEdit } from '#shared/file-edits-core.ts';

export type ToolCallState = 'running' | 'stopped' | 'done' | 'failed';

export interface ToolCallEntry {
  toolUseId: string;
  label: string;
  skillName: string | null;
  state: ToolCallState;
  startedAt: number;
  durationMs: number | null;
  outputHead: string | null;
  imageFileNames: readonly string[];
}

export type TurnSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; calls: ToolCallEntry[]; callCount: number; settledCount: number }
  | { kind: 'answers'; answeredQuestions: readonly AnsweredQuestion[] }
  | { kind: 'plan'; planText: string };

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

const ARGUMENT_FIELDS = ['description', 'command', 'CommandLine', 'cmd', 'pattern', 'query', 'url', 'Url', 'prompt'] as const;
const LEADING_CD = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/;
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
  return inlines.some((inline) => inline.type === 'link' || inline.type === 'fileRef' || ('children' in inline && hasLink(inline.children)));
}

export function interimReplyText(text: string): string | null {
  const trimmedText = text.trim();
  if (trimmedText.length > MAX_INTERIM_REPLY_CHARS || trimmedText.includes('\n')) return null;
  const blocks = parsePlanMarkdown(trimmedText);
  const onlyBlock = blocks[0];
  if (blocks.length !== 1 || onlyBlock?.type !== 'paragraph' || hasLink(onlyBlock.children)) return null;
  return normalizedSpace(inlineText(onlyBlock.children));
}

export function currentCallOf(segments: readonly TurnSegment[]): string {
  const lastRun = segments.findLast((segment) => segment.kind === 'tools');
  return lastRun?.kind === 'tools' ? lastRun.calls.at(-1)?.label ?? '' : '';
}

export function isInterimReply(text: string): boolean {
  return interimReplyText(text) !== null;
}

export function digestTurn(segments: readonly TurnSegment[], toolCount: number): TurnDigest {
  const texts = textsOf(segments);
  const finalText = texts.at(-1);
  return { asked: finalText === undefined ? null : askedOf(finalText), isFoldable: toolCount > 0 || texts.length > 1 };
}

function baseNameOf(path: string): string {
  return path.split(/[\\/]/).filter((piece) => piece !== '').at(-1) ?? path;
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
  if (path !== null) return `${name} ${baseNameOf(path)}`;
  const argument = firstStringField(input, ARGUMENT_FIELDS);
  if (argument === null) return name;
  const shownArgument = shortArgumentOf(argument, workingDirectory);
  if (isShellTool(name)) return shownArgument;
  return `${name} ${shownArgument}`;
}

export function truncatedFileEditsOf(input: unknown, workingDirectory: string | null): FileEdit[] {
  const cutJson = typeof input === 'string' ? input : JSON.stringify(input) ?? '';
  const path = CUT_PATH_FIELD.exec(cutJson)?.[2] ?? CUT_CODEX_CHANGE_PATH.exec(cutJson)?.[1] ?? null;
  if (path === null) return [{ path: '', added: 0, removed: 0, hasLineCounts: false }];
  return [{ path: shownPathOf(path, workingDirectory), added: 0, removed: 0, hasLineCounts: false }];
}

const OUTPUT_HEAD_LINES = 12;
const OUTPUT_HEAD_MAX_CHARS = 2000;

export function outputHeadOf(content: string): string | null {
  const head = content.split('\n').slice(0, OUTPUT_HEAD_LINES).join('\n').slice(0, OUTPUT_HEAD_MAX_CHARS).trimEnd();
  return head.length === 0 ? null : head;
}

function prefixedLinesOf(text: string, prefix: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n$/, '').split('\n').map((line) => `${prefix}${line}`);
}

export interface FilePatch {
  path: string;
  patch: string;
}

function filePatchOf(path: string, body: readonly string[]): FilePatch {
  return { path, patch: [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body, ''].join('\n') };
}

function hunkOf(oldText: string, newText: string): string[] {
  const removedLines = prefixedLinesOf(oldText, '-');
  const addedLines = prefixedLinesOf(newText, '+');
  return [`@@ -1,${removedLines.length} +1,${addedLines.length} @@`, ...removedLines, ...addedLines];
}

function oldNewHunksOf(input: unknown): string[] | null {
  for (const [oldField, newField] of OLD_NEW_FIELD_PAIRS) {
    if (typeof input !== 'object' || input === null || !(oldField in input) || !(newField in input)) continue;
    const oldText: unknown = Reflect.get(input, oldField);
    const newText: unknown = Reflect.get(input, newField);
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null;
    return hunkOf(oldText, newText);
  }
  return null;
}

function editListHunksOf(input: unknown): string[] | null {
  if (typeof input !== 'object' || input === null) return null;
  for (const field of EDIT_LIST_FIELDS) {
    const edits: unknown = Reflect.get(input, field);
    if (Array.isArray(edits)) return edits.flatMap((edit) => oldNewHunksOf(edit) ?? []);
  }
  return null;
}

function codexChangePatchOf(path: string, change: unknown, workingDirectory: string | null): FilePatch | null {
  const shownPath = shownPathOf(path, workingDirectory);
  const unifiedDiff = stringField(change, 'unified_diff');
  if (unifiedDiff !== null) return filePatchOf(shownPath, unifiedDiff.replace(/\n$/, '').split('\n'));
  const content = stringField(change, 'content') ?? '';
  const changeType = stringField(change, 'type');
  if (changeType === 'add') return filePatchOf(shownPath, hunkOf('', content));
  if (changeType === 'delete') return filePatchOf(shownPath, hunkOf(content, ''));
  return null;
}

export function filePatchesOf(input: unknown, workingDirectory: string | null): FilePatch[] {
  if (typeof input === 'object' && input !== null) {
    const changes: unknown = Reflect.get(input, 'changes');
    if (typeof changes === 'object' && changes !== null && !Array.isArray(changes)) {
      return Object.entries(changes).flatMap(([path, change]) => codexChangePatchOf(path, change, workingDirectory) ?? []);
    }
  }
  const path = firstStringField(input, PATH_FIELDS);
  if (path === null) return [];
  const shownPath = shownPathOf(path, workingDirectory);
  const hunks = oldNewHunksOf(input) ?? editListHunksOf(input);
  if (hunks !== null) return hunks.length === 0 ? [] : [filePatchOf(shownPath, hunks)];
  const wholeFile = firstStringField(input, WHOLE_FILE_FIELDS);
  return wholeFile === null ? [] : [filePatchOf(shownPath, hunkOf('', wholeFile))];
}
