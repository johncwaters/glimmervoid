import path from 'node:path';

import { openContainedFile } from '../contained-file.ts';
import type { ContainmentRefusal } from '../core/trace-tail-core.ts';
import { buildChangeMapView } from '../../shared/change-map-view-core.ts';
import type { ChangeMap } from '../../shared/contracts/change-map.ts';
import type { WorthALookPath } from '../../shared/contracts/whiteboard.ts';
import { parseRef } from '../../shared/whiteboard-anchor-core.ts';
import type { ChangeFacts, FileFact, ParsedRef } from '../../shared/whiteboard-anchor-core.ts';
import { hashText } from '../core/text-hash-core.ts';
import { errorMessage } from '../../shared/text.ts';

const MAX_ANCHOR_FILE_BYTES = 512 * 1024;
const NEWLINE_BYTE = 0x0a;

const PROBLEM_BY_REFUSAL: Readonly<Record<ContainmentRefusal, string>> = {
  missing: 'no such file',
  unreadable: 'the file could not be read',
  'outside-root': 'the path leads outside the code session worktree, so it was not read',
  'not-a-regular-file': 'it is not a file',
  'root-unresolvable': 'the code session worktree could not be read',
};

function lineCountOf(bytes: Uint8Array): number {
  let newlineCount = 0;
  for (const byte of bytes) if (byte === NEWLINE_BYTE) newlineCount += 1;
  const hasUnterminatedLastLine = bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE_BYTE;
  return newlineCount + (hasUnterminatedLastLine ? 1 : 0);
}

interface ReadAnchorFile {
  fact: FileFact;
  lines: readonly string[] | null;
}

interface AnchorFileFacts {
  fileFactByPath: Map<string, FileFact>;
  hashByRef: Map<string, string | null>;
}

async function anchorFileOf(root: string, refPath: string): Promise<ReadAnchorFile> {
  const opened = await openContainedFile(path.join(root, refPath), root);
  if (!opened.ok) return { fact: { problem: PROBLEM_BY_REFUSAL[opened.reason] }, lines: null };
  const { handle, stat } = opened.file;
  try {
    if (stat.size > MAX_ANCHOR_FILE_BYTES) return { fact: { lineCount: null }, lines: null };
    const bytes = await handle.readFile();
    return { fact: { lineCount: lineCountOf(bytes) }, lines: bytes.toString('utf8').split('\n') };
  } catch {
    return { fact: { problem: PROBLEM_BY_REFUSAL.unreadable }, lines: null };
  } finally {
    await handle.close().catch(() => {});
  }
}

function hashOfRefLines(parsed: ParsedRef, lines: readonly string[] | null, lineCount: number | null): string | null {
  if (lines === null || lineCount === null) return null;
  if (parsed.startLine === null) return hashText(lines.join('\n'));
  const endLine = parsed.endLine ?? parsed.startLine;
  if (endLine > lineCount) return null;
  return hashText(lines.slice(parsed.startLine - 1, endLine).join('\n'));
}

async function readAnchorFileFacts(root: string, refs: readonly string[]): Promise<AnchorFileFacts> {
  const parsedRefsByPath = new Map<string, { ref: string; parsed: ParsedRef }[]>();
  for (const ref of refs) {
    const parsed = parseRef(ref);
    if (!('path' in parsed)) continue;
    const parsedRefsOfPath = parsedRefsByPath.get(parsed.path) ?? [];
    parsedRefsOfPath.push({ ref, parsed });
    parsedRefsByPath.set(parsed.path, parsedRefsOfPath);
  }
  const fileFactByPath = new Map<string, FileFact>();
  const hashByRef = new Map<string, string | null>();
  for (const [refPath, parsedRefs] of parsedRefsByPath) {
    const file = await anchorFileOf(root, refPath);
    fileFactByPath.set(refPath, file.fact);
    for (const { ref, parsed } of parsedRefs) hashByRef.set(ref, hashOfRefLines(parsed, file.lines, 'lineCount' in file.fact ? file.fact.lineCount : null));
  }
  return { fileFactByPath, hashByRef };
}

function worthALookOf(map: ChangeMap): WorthALookPath[] {
  const reasonsByPath = new Map<string, string[]>();
  for (const line of buildChangeMapView(map).worthALook.flatMap((group) => group.lines)) {
    const reasons = reasonsByPath.get(line.openPath) ?? [];
    if (!reasons.includes(line.heading)) reasons.push(line.heading);
    reasonsByPath.set(line.openPath, reasons);
  }
  return [...reasonsByPath].map(([openPath, reasons]) => ({ path: openPath, reason: reasons.join('; ') }));
}

function changeFactsOf(map: ChangeMap): ChangeFacts | null {
  if (map.repos.length === 0 && !map.error) return null;
  const changedPaths = map.repos.flatMap((repo) => repo.files.map((file) => ({ path: `${repo.sessionPathPrefix}${file.path}`, isCommitted: file.isCommitted })));
  return { changedPaths, worthALook: worthALookOf(map), error: map.error ?? null };
}

async function readChangeFacts(buildChangeMap: () => Promise<ChangeMap>): Promise<ChangeFacts | null> {
  try {
    return changeFactsOf(await buildChangeMap());
  } catch (error) {
    return { changedPaths: [], worthALook: [], error: errorMessage(error) };
  }
}

export { readAnchorFileFacts, readChangeFacts };
