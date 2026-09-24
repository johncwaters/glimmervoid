import { attentionSignature } from './attention-ack-core.ts';
import { numberOr, textOr } from './coerce-core.ts';

export interface TeamReviewRow {
  number?: number;
  phase?: string | null;
  inFlight?: boolean;
  wasConflicting?: boolean;
  title?: string;
  url?: string;
  headSha?: string;
  reason?: string;
}

export interface TeamReviewProject {
  projectId?: string;
  name?: string;
  repoSlug?: string;
  lastTickAt?: number;
  prs?: TeamReviewRow[] | null;
}

export interface TeamReviewStatusSnapshot {
  projects?: (TeamReviewProject | null)[];
}

const PHASE_RANK: Record<string, number> = {
  error: 0,
  done: 1,
  'changes-requested': 1,
  conflicting: 2,
  'resolving-conflicts': 2,
  'in-review': 3,
  pending: 4,
  clean: 5,
};

const PHASE_SEVERITY: Record<string, string> = {
  error: 'crit',
  done: 'warn',
  'changes-requested': 'warn',
  conflicting: 'warn',
  'resolving-conflicts': 'warn',
  'in-review': 'info',
  pending: 'dim',
  clean: 'ok',
};

const PHASE_LABEL: Record<string, string> = {
  error: 'error',
  done: 'changes requested',
  'changes-requested': 'changes requested',
  conflicting: 'conflicting',
  'resolving-conflicts': 'resolving',
  'in-review': 'in review',
  pending: 'pending',
  clean: 'clean',
};

const UNKNOWN_RANK = 99;

export const PENDING_PHASE = 'pending';

export function prStatusPlaceholder(_status: TeamReviewStatusSnapshot | null | undefined) {
  return 'No pull requests to review.';
}

export function normalizePhase(phase: string | null | undefined) {
  return phase == null ? PENDING_PHASE : phase;
}

export function phaseLabel(phase: string | null | undefined) {
  const key = normalizePhase(phase);
  const label = PHASE_LABEL[key];
  if (label) return { label, known: true };
  return { label: String(key), known: false };
}

export function severityFor(phase: string | null | undefined, { inFlight = false }: { inFlight?: boolean } = {}) {
  const mapped = PHASE_SEVERITY[normalizePhase(phase)];
  if (mapped) return mapped;
  if (inFlight) return 'info';
  return 'dim';
}

export function prHasError(pr: TeamReviewRow | null | undefined) {
  return pr?.phase === 'error';
}

export function summarizePrs(prs: unknown) {
  const list: TeamReviewRow[] = Array.isArray(prs) ? prs : [];
  let inReview = 0;
  let errors = 0;
  for (const pr of list) {
    if (pr?.inFlight) inReview += 1;
    if (prHasError(pr)) errors += 1;
  }
  return { open: list.length, inReview, errors };
}

export function prAttentionSignature(snapshot: TeamReviewStatusSnapshot | null | undefined) {
  const projects: (TeamReviewProject | null)[] = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
  const parts: string[] = [];
  for (const project of projects) {
    const label = textOr(project?.repoSlug, textOr(project?.projectId, 'project'));
    const prs: TeamReviewRow[] = Array.isArray(project?.prs) ? project.prs : [];
    for (const pr of prs) {
      if (!prHasError(pr)) continue;
      parts.push(`${label}#${numberOr(pr?.number, '?')}:${normalizePhase(pr?.phase)}`);
    }
  }
  return attentionSignature(parts);
}

const NEEDS_ACTION_PHASES = new Set(['error', 'done', 'changes-requested', 'conflicting']);

export function prNeedsAction(pr: TeamReviewRow | null | undefined) {
  return NEEDS_ACTION_PHASES.has(normalizePhase(pr?.phase));
}

function rankFor(pr: TeamReviewRow | null | undefined) {
  const rank = PHASE_RANK[normalizePhase(pr?.phase)];
  return rank == null ? UNKNOWN_RANK : rank;
}

export function sortPrsByAttention(prs: unknown): TeamReviewRow[] {
  if (!Array.isArray(prs)) return [];
  return (prs as TeamReviewRow[])
    .map((pr, index) => ({ pr, index }))
    .sort((a, b) => {
      const byRank = rankFor(a.pr) - rankFor(b.pr);
      if (byRank !== 0) return byRank;
      const byNumber = numberOr(b.pr?.number, 0) - numberOr(a.pr?.number, 0);
      if (byNumber !== 0) return byNumber;
      return a.index - b.index;
    })
    .map((entry) => entry.pr);
}
