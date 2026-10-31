import type { Board, BoardReview, Box, Element } from './contracts/whiteboard.ts';
import { cappedWarnings } from './whiteboard-route-core.ts';

const MAX_REFERENCED_PATHS = 64;

type BoxLine = Box['lines'][number];

interface ParsedRef {
  path: string;
  startLine: number | null;
  endLine: number | null;
}

interface AnchorSite {
  elementId: string;
  ref: string;
  where: string;
}

type FileFact = { lineCount: number | null } | { problem: string };

interface AnchorFacts {
  fileFactByPath: ReadonlyMap<string, FileFact>;
}

const REF_PATTERN = /^([^#\s]+)(?:#L([1-9]\d*)(?:-L([1-9]\d*))?)?$/;

function isAbsoluteRefPath(refPath: string): boolean {
  return refPath.startsWith('/') || refPath.startsWith('\\') || /^[A-Za-z]:/.test(refPath);
}

function parseRef(ref: string): ParsedRef | { error: string } {
  const match = REF_PATTERN.exec(ref);
  if (!match?.[1]) return { error: 'a ref is path, path#L12 or path#L12-L30' };
  const refPath = match[1];
  if (isAbsoluteRefPath(refPath)) return { error: 'an absolute path is never read; name the file relative to the code session worktree' };
  if (refPath.split(/[\\/]/).includes('..')) return { error: 'a path with .. is never read; name the file relative to the code session worktree' };
  const startLine = match[2] ? Number(match[2]) : null;
  const endLine = match[3] ? Number(match[3]) : startLine;
  if (startLine !== null && endLine !== null && endLine < startLine) return { error: 'the line range ends before it starts' };
  return { path: refPath, startLine, endLine };
}

function lineSites(elementName: string, elementId: string, lines: readonly BoxLine[]): AnchorSite[] {
  return lines.flatMap((line, index) => (line.ref ? [{ elementId, ref: line.ref, where: `line ${index + 1} of ${elementName}` }] : []));
}

function sitesOfElement(element: Element): AnchorSite[] {
  const elementName = `${element.kind} ${element.id}`;
  switch (element.kind) {
    case 'box':
    case 'unit':
      return [...element.refs.map((ref) => ({ elementId: element.id, ref, where: elementName })), ...lineSites(elementName, element.id, element.lines)];
    case 'panel': return lineSites(elementName, element.id, element.lines);
    case 'note': return element.ref ? [{ elementId: element.id, ref: element.ref, where: elementName }] : [];
    case 'frame':
    case 'wire':
      return [];
  }
}

function anchorSitesOf(board: Board): AnchorSite[] {
  return Object.values(board.elements).flatMap(sitesOfElement);
}

function referencedPaths(board: Board): string[] {
  const paths = new Set<string>();
  for (const site of anchorSitesOf(board)) {
    const parsed = parseRef(site.ref);
    if ('path' in parsed) paths.add(parsed.path);
  }
  return [...paths].slice(0, MAX_REFERENCED_PATHS);
}

function siteProblem(site: AnchorSite, facts: AnchorFacts): string | null {
  const parsed = parseRef(site.ref);
  if ('error' in parsed) return parsed.error;
  const fact = facts.fileFactByPath.get(parsed.path);
  if (!fact) return `not checked, since the board names more than ${MAX_REFERENCED_PATHS} files`;
  if ('problem' in fact) return fact.problem;
  const lastLine = parsed.endLine ?? parsed.startLine;
  if (lastLine === null) return null;
  if (fact.lineCount === null) return 'the file is too large to check its lines';
  if (lastLine > fact.lineCount) return `the file has ${fact.lineCount} lines`;
  return null;
}

function unreviewedWarning(codeSessionId: string | null): string {
  if (codeSessionId === null) return 'refs on this board were not checked: it has no code session, so set one with {"op":"board","codeSessionId":"<session id>"}';
  return `refs on this board were not checked: code session ${codeSessionId} is not running`;
}

function reviewBoard(board: Board, facts: AnchorFacts | null): BoardReview {
  const { codeSessionId } = board;
  const sites = anchorSitesOf(board);
  if (sites.length === 0) return { codeSessionId, anchorWarnings: [] };
  if (!facts) return { codeSessionId, anchorWarnings: [unreviewedWarning(codeSessionId)] };
  const anchorWarnings = sites.flatMap((site) => {
    const problem = siteProblem(site, facts);
    return problem ? [`ref ${site.ref} on ${site.where}: ${problem}`] : [];
  });
  return { codeSessionId, anchorWarnings: cappedWarnings(anchorWarnings) };
}

export { anchorSitesOf, parseRef, referencedPaths, reviewBoard };
export type { AnchorFacts, AnchorSite, FileFact, ParsedRef };
