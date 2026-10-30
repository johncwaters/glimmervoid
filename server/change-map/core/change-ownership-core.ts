import {
  CHANGE_MAP_LIST_CAP,
  changeMapFactId,
  type CollisionFact,
  type ConflictRisk,
  type SubsystemFact,
} from '../../../shared/contracts/change-map.ts';
import { HUNK_HEADER, diffHeaderPath } from '../../github/core/team-review-core.ts';

const NEAR_EDIT_LINE_GAP_MAX = 3;

interface BaseLineRange {
  start: number;
  end: number;
}

interface FileEdits {
  isAdded: boolean;
  isComparable: boolean;
  baseRanges: BaseLineRange[];
}

export type FileEditsByPath = Map<string, FileEdits>;

interface ConflictRating {
  risk: ConflictRisk;
  evidence: string;
}

const UNCOMPARED_RATING: ConflictRating = { risk: 'medium', evidence: 'The two sessions\' edits could not be compared line by line.' };

export function readAgentsTitle(markdown: string): string {
  const heading = markdown.match(/^# (.*)$/m);
  return heading?.[1].trim() ?? '';
}

export function computeSubsystems({ repoName, changedPaths, agentsDocs }: {
  repoName: string;
  changedPaths: string[];
  agentsDocs: { path: string; title: string }[];
}): SubsystemFact[] {
  const agentsDocsByDirectory = new Map<string, { path: string; title: string }>();
  for (const agentsDoc of agentsDocs) {
    const directory = agentsDoc.path === 'AGENTS.md' ? '' : agentsDoc.path.slice(0, -'/AGENTS.md'.length);
    agentsDocsByDirectory.set(directory, agentsDoc);
  }

  const pathsByAgentsPath = new Map<string, string[]>();
  for (const changedPath of changedPaths) {
    let directory = changedPath.slice(0, changedPath.lastIndexOf('/') + 1).replace(/\/$/, '');
    while (true) {
      const owner = agentsDocsByDirectory.get(directory);
      if (owner) {
        const ownedPaths = pathsByAgentsPath.get(owner.path) ?? [];
        ownedPaths.push(changedPath);
        pathsByAgentsPath.set(owner.path, ownedPaths);
        break;
      }
      if (!directory) break;
      const parentSeparator = directory.lastIndexOf('/');
      directory = parentSeparator < 0 ? '' : directory.slice(0, parentSeparator);
    }
  }

  return [...pathsByAgentsPath].map(([agentsPath, paths]) => {
    const directory = agentsPath === 'AGENTS.md' ? '' : agentsPath.slice(0, -'/AGENTS.md'.length);
    const title = agentsDocsByDirectory.get(directory)?.title || directory || repoName;
    return {
      factId: changeMapFactId('subsystem', repoName, agentsPath),
      agentsPath,
      title,
      paths: paths.sort(),
    };
  }).sort((left, right) => right.paths.length - left.paths.length || left.agentsPath.localeCompare(right.agentsPath));
}

export function parseZeroContextDiff(diffText: string): FileEditsByPath {
  const editsByPath: FileEditsByPath = new Map();
  let oldPath: string | null = null;
  let isAdded = false;
  let current: FileEdits | null = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = null;
      isAdded = false;
      current = null;
      continue;
    }
    if (line.startsWith('new file mode')) {
      isAdded = true;
      continue;
    }
    if (line.startsWith('Binary files ')) {
      const binaryPath = line.match(/ and b\/(.*) differ$/)?.[1];
      if (binaryPath) editsByPath.set(binaryPath, { isAdded, isComparable: false, baseRanges: [] });
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = diffHeaderPath(line, 'a/');
      continue;
    }
    if (line.startsWith('+++ ')) {
      const filePath = diffHeaderPath(line, 'b/') ?? oldPath;
      current = filePath === null ? null : { isAdded, isComparable: true, baseRanges: [] };
      if (filePath !== null && current) editsByPath.set(filePath, current);
      continue;
    }
    const hunkHeader = current ? HUNK_HEADER.exec(line) : null;
    if (!hunkHeader || !current) continue;
    const start = Number(hunkHeader[1]);
    const removedLineCount = hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]);
    current.baseRanges.push({ start, end: start + Math.max(removedLineCount, 1) - 1 });
  }
  return editsByPath;
}

function closestEditPair(selfRanges: BaseLineRange[], otherRanges: BaseLineRange[]) {
  let closest: { gap: number; line: number } | null = null;
  let selfIndex = 0;
  let otherIndex = 0;
  while (selfIndex < selfRanges.length && otherIndex < otherRanges.length) {
    const selfRange = selfRanges[selfIndex];
    const otherRange = otherRanges[otherIndex];
    const gap = Math.max(selfRange.start, otherRange.start) - Math.min(selfRange.end, otherRange.end);
    if (!closest || gap < closest.gap) closest = { gap, line: Math.max(selfRange.start, otherRange.start) };
    if (selfRange.end < otherRange.end) selfIndex++;
    if (selfRange.end >= otherRange.end) otherIndex++;
  }
  return closest;
}

function rateConflictRisk(selfEdits: FileEdits | undefined, otherEdits: FileEdits | undefined): ConflictRating {
  if (!selfEdits || !otherEdits) return UNCOMPARED_RATING;
  if (selfEdits.isAdded && otherEdits.isAdded) return { risk: 'high', evidence: 'Both sessions create this file.' };
  if (!selfEdits.isComparable || !otherEdits.isComparable) return { risk: 'medium', evidence: 'Binary file, so the edits cannot be compared line by line.' };
  const closest = closestEditPair(selfEdits.baseRanges, otherEdits.baseRanges);
  if (!closest) return { risk: 'low', evidence: 'Only one session still differs from the shared starting point.' };
  if (closest.gap <= 0) return { risk: 'high', evidence: `Both sessions edit the same lines near line ${closest.line}.` };
  if (closest.gap <= NEAR_EDIT_LINE_GAP_MAX) return { risk: 'high', evidence: `Both sessions edit within ${closest.gap} lines of each other near line ${closest.line}.` };
  return { risk: 'low', evidence: `The closest edits are ${closest.gap} lines apart.` };
}

export function computeCollisions({ repoName, changedPaths, otherSessions, selfEditsFor }: {
  repoName: string;
  changedPaths: string[];
  otherSessions: { id: string; name: string; changedPaths: string[]; editsByPath: FileEditsByPath | null }[];
  selfEditsFor: (otherSessionId: string) => FileEditsByPath | null;
}): CollisionFact[] {
  const changedPathSet = new Set(changedPaths);
  const collisions: CollisionFact[] = [];
  for (const otherSession of otherSessions) {
    const selfEditsByPath = selfEditsFor(otherSession.id);
    for (const path of new Set(otherSession.changedPaths)) {
      if (!changedPathSet.has(path)) continue;
      const rating = rateConflictRisk(selfEditsByPath?.get(path), otherSession.editsByPath?.get(path));
      collisions.push({
        factId: changeMapFactId('collision', repoName, path, otherSession.id),
        path,
        otherSessionId: otherSession.id,
        otherSessionName: otherSession.name,
        conflictRisk: rating.risk,
        conflictEvidence: rating.evidence,
      });
    }
  }
  return collisions.sort((left, right) => left.path.localeCompare(right.path)
    || left.otherSessionName.localeCompare(right.otherSessionName)
    || left.otherSessionId.localeCompare(right.otherSessionId)).slice(0, CHANGE_MAP_LIST_CAP);
}
