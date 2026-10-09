import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { inferRecordKind } from './coherence-delta.ts';
import type { GraphSchema } from './graph-schema.ts';

const TaskStatus = z.enum(['todo', 'doing', 'waiting', 'done', 'dropped']);
const ProjectStatus = z.enum(['active', 'paused', 'done', 'archived']);
const TaskPriority = z.enum(['p0', 'p1', 'p2', 'p3']);
const AbsoluteRepoPath = z.string().refine((repoPath) => posix.isAbsolute(repoPath) || win32.isAbsolute(repoPath), { message: 'repo must be an absolute path' });

export const personalSchema: GraphSchema = {
  name: 'personal',
  version: 1,
  kinds: {
    project: {
      idPrefix: 'P',
      description: 'A body of work with an outcome (a work project, a side project)',
      properties: z.strictObject({
        status: ProjectStatus.default('active'),
        area: z.enum(['work', 'personal']).default('work'),
      }),
    },
    task: {
      idPrefix: 'T',
      description: 'A concrete next action',
      properties: z.strictObject({
        status: TaskStatus.default('todo'),
        priority: TaskPriority.default('p2'),
        due: z.iso.date().optional(),
      }),
    },
    note: {
      idPrefix: 'N',
      description: 'Knowledge you want to keep: a fact, a how-to, an insight, a log entry',
      properties: z.strictObject({
        noteType: z.enum(['fact', 'howto', 'insight', 'log']).default('insight'),
      }),
    },
    reference: {
      idPrefix: 'R',
      description: 'An external source: article, paper, book, repo, doc, video, talk',
      properties: z.strictObject({
        medium: z.enum(['article', 'paper', 'book', 'repo', 'doc', 'video', 'talk']).default('article'),
        url: z.url().optional(),
        author: z.string().min(1).optional(),
      }),
    },
    question: {
      idPrefix: 'Q',
      description: 'An open research question',
      properties: z.strictObject({
        status: z.enum(['open', 'answered', 'parked']).default('open'),
      }),
    },
    coherence_record: {
      idPrefix: 'C',
      description: 'A pointer to a work order or decision in a repo\'s Coherence ledger; the ledger stays the source of truth',
      properties: z.strictObject({
        repo: AbsoluteRepoPath,
        record: z.enum(['work', 'decision']),
        recordId: z.string(),
      }).refine((pointer) => inferRecordKind(pointer.recordId) === pointer.record, { message: 'recordId does not match record kind', path: ['recordId'] }),
    },
    topic: {
      idPrefix: 'TP',
      description: 'A subject area that cuts across projects',
      properties: z.strictObject({}),
    },
  },
  edges: {
    part_of: {
      description: 'Belongs to a project',
      fromKinds: ['task', 'note', 'reference', 'question'],
      toKinds: ['project'],
      maxOutgoingPerNode: 1,
    },
    subtask_of: {
      description: 'Is a step of a larger task',
      fromKinds: ['task'],
      toKinds: ['task'],
      maxOutgoingPerNode: 1,
      isAcyclic: true,
    },
    blocks: {
      description: 'Must finish before the target task can start',
      fromKinds: ['task'],
      toKinds: ['task'],
      isAcyclic: true,
    },
    cites: {
      description: 'Draws on an external source',
      fromKinds: ['note', 'question', 'task', 'project'],
      toKinds: ['reference'],
    },
    answers: {
      description: 'Resolves a research question',
      fromKinds: ['note'],
      toKinds: ['question'],
    },
    supersedes: {
      description: 'Replaces an older note',
      fromKinds: ['note'],
      toKinds: ['note'],
      maxOutgoingPerNode: 1,
      isAcyclic: true,
    },
    tracked_by: {
      description: 'Is carried out or settled by a record in a Coherence ledger',
      fromKinds: ['project', 'task', 'note', 'question'],
      toKinds: ['coherence_record'],
    },
    about: {
      description: 'Is about a topic',
      fromKinds: 'any',
      toKinds: ['topic'],
    },
    relates_to: {
      description: 'Loosely related; prefer a specific edge when one fits',
      fromKinds: 'any',
      toKinds: 'any',
    },
  },
};

const closedTaskStatuses = new Set(['done', 'dropped']);
const actionableTaskStatuses = new Set(['todo', 'doing']);
const priorityRank: Record<string, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

export type NextActionCandidate = {
  id: string;
  title: string;
  status: string;
  priority: string;
  due: string | undefined;
  projectStatus: string | undefined;
  openBlockerIds: string[];
};

export function isTaskClosed(status: unknown): boolean {
  return typeof status === 'string' && closedTaskStatuses.has(status);
}

export function rankNextActions(candidates: readonly NextActionCandidate[]): NextActionCandidate[] {
  const isActionable = (candidate: NextActionCandidate) =>
    actionableTaskStatuses.has(candidate.status)
    && candidate.openBlockerIds.length === 0
    && (candidate.projectStatus === undefined || candidate.projectStatus === 'active');
  const compareCandidates = (left: NextActionCandidate, right: NextActionCandidate): number => {
    const statusOrder = Number(right.status === 'doing') - Number(left.status === 'doing');
    if (statusOrder !== 0) return statusOrder;
    const priorityOrder = (priorityRank[left.priority] ?? 9) - (priorityRank[right.priority] ?? 9);
    if (priorityOrder !== 0) return priorityOrder;
    return (left.due ?? '9999-12-31').localeCompare(right.due ?? '9999-12-31');
  };
  return candidates.filter(isActionable).toSorted(compareCandidates);
}
