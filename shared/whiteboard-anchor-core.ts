import { WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import type { Board, BoardReview, Box, Element, Unit } from './contracts/whiteboard.ts';
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

interface ChangedPath {
  path: string;
  isCommitted: boolean;
}

interface ChangeFacts {
  changedPaths: readonly ChangedPath[];
  worthALookPaths: readonly string[];
  error: string | null;
}

interface AnchorFacts {
  fileFactByPath: ReadonlyMap<string, FileFact>;
  changes: ChangeFacts | null;
}

type ChangeReview = Pick<BoardReview, 'unitWarnings' | 'uncoveredPaths' | 'worthALookPaths'>;

const NO_CHANGE_REVIEW: ChangeReview = Object.freeze({ unitWarnings: [], uncoveredPaths: [], worthALookPaths: [] });

const REF_PATTERN = /^([^#\s]+)(?:#L([1-9]\d*)(?:-L([1-9]\d*))?)?$/;

function isAbsoluteRefPath(refPath: string): boolean {
  return refPath.startsWith('/') || refPath.startsWith('\\') || /^[A-Za-z]:/.test(refPath);
}

function canonicalRefPath(refPath: string): string {
  return refPath.split('/').filter((segment) => segment !== '' && segment !== '.').join('/');
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
  return { path: canonicalRefPath(refPath), startLine, endLine };
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

function refPathsOf(sites: readonly AnchorSite[]): Set<string> {
  return new Set(sites.flatMap((site) => {
    const parsed = parseRef(site.ref);
    return 'path' in parsed ? [parsed.path] : [];
  }));
}

function unitWarningsOf(unit: Unit, unitPaths: ReadonlySet<string>, changedByPath: ReadonlyMap<string, ChangedPath>): string[] {
  if (unit.status === 'planned') {
    const startedPath = [...unitPaths].find((unitPath) => changedByPath.has(unitPath));
    return startedPath ? [`unit ${unit.id} is planned but ${startedPath} already changed`] : [];
  }
  if (unit.status !== 'landed') return [];
  return [...unitPaths].flatMap((unitPath) => {
    const changed = changedByPath.get(unitPath);
    if (!changed) return [`unit ${unit.id} is landed but ${unitPath} is unchanged`];
    return changed.isCommitted ? [] : [`unit ${unit.id} is landed but ${unitPath} has uncommitted changes`];
  });
}

function changeReviewOf(board: Board, sites: readonly AnchorSite[], changes: ChangeFacts | null): ChangeReview {
  if (!changes) return NO_CHANGE_REVIEW;
  if (changes.error) return { ...NO_CHANGE_REVIEW, unitWarnings: [`the code session changes could not be read: ${changes.error}`] };
  const refPaths = refPathsOf(sites);
  const changedByPath = new Map(changes.changedPaths.map((changed) => [changed.path, changed]));
  const unitWarnings = Object.values(board.elements).flatMap((element) => {
    if (element.kind !== 'unit') return [];
    return unitWarningsOf(element, refPathsOf(sitesOfElement(element)), changedByPath);
  });
  const uncoveredPaths = [...changedByPath.keys()].filter((changedPath) => !refPaths.has(changedPath)).sort();
  const worthALookPaths = [...new Set(changes.worthALookPaths)].filter((worthPath) => refPaths.has(worthPath));
  return { unitWarnings: cappedWarnings(unitWarnings), uncoveredPaths: uncoveredPaths.slice(0, WHITEBOARD_LIMITS.layoutWarnings), worthALookPaths: worthALookPaths.slice(0, WHITEBOARD_LIMITS.layoutWarnings) };
}

function reviewBoard(board: Board, facts: AnchorFacts | null): BoardReview {
  const { codeSessionId } = board;
  const sites = anchorSitesOf(board);
  if (!facts) return { codeSessionId, anchorWarnings: sites.length === 0 ? [] : [unreviewedWarning(codeSessionId)], ...NO_CHANGE_REVIEW };
  const anchorWarnings = sites.flatMap((site) => {
    const problem = siteProblem(site, facts);
    return problem ? [`ref ${site.ref} on ${site.where}: ${problem}`] : [];
  });
  return { codeSessionId, anchorWarnings: cappedWarnings(anchorWarnings), ...changeReviewOf(board, sites, facts.changes) };
}

export { referencedPaths, reviewBoard };
export type { ChangeFacts, FileFact };
