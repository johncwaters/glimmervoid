import { z } from 'zod';

export const CHANGE_MAP_LIST_CAP = 20;
export const CHANGE_MAP_CLAIM_MAX_CHARS = 600;
export const CHANGE_MAP_CLAIMS_MAX = 12;

export const CHANGE_MAP_FACT_KINDS = Object.freeze([
  'file', 'subsystem', 'co-change', 'hotspot', 'blast', 'untested', 'collision',
] as const);
export type ChangeMapFactKind = (typeof CHANGE_MAP_FACT_KINDS)[number];

export function changeMapFactId(kind: ChangeMapFactKind, repoName: string, ...parts: string[]): string {
  return [kind, repoName, ...parts].join(':');
}

const factId = z.string().min(1);
const repoPath = z.string().min(1);
const count = z.number().int().nonnegative();
const cappedPaths = z.array(repoPath).max(CHANGE_MAP_LIST_CAP);

export const ChangedFileStatus = z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']);
export type ChangedFileStatus = z.infer<typeof ChangedFileStatus>;

export const ChangedFile = z.strictObject({
  factId,
  path: repoPath,
  previousPath: repoPath.optional(),
  status: ChangedFileStatus,
  isCommitted: z.boolean(),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

export const SubsystemFact = z.strictObject({
  factId,
  agentsPath: repoPath,
  title: z.string(),
  paths: z.array(repoPath).min(1),
});
export type SubsystemFact = z.infer<typeof SubsystemFact>;

export const CoChangeGap = z.strictObject({
  factId,
  path: repoPath,
  partner: repoPath,
  support: count,
  confidence: z.number().min(0).max(1),
});
export type CoChangeGap = z.infer<typeof CoChangeGap>;

export const HotspotFact = z.strictObject({
  factId,
  path: repoPath,
  commitCount: count,
  fixCommitCount: count,
});
export type HotspotFact = z.infer<typeof HotspotFact>;

export const BlastRadiusFact = z.strictObject({
  factId,
  path: repoPath,
  directDependents: cappedPaths,
  directDependentCount: count,
  transitiveDependentCount: count,
  dependentTests: cappedPaths,
  dependentTestCount: count,
});
export type BlastRadiusFact = z.infer<typeof BlastRadiusFact>;

export const UntestedFileFact = z.strictObject({
  factId,
  path: repoPath,
});
export type UntestedFileFact = z.infer<typeof UntestedFileFact>;

export const CollisionFact = z.strictObject({
  factId,
  path: repoPath,
  otherSessionId: z.string().min(1),
  otherSessionName: z.string(),
});
export type CollisionFact = z.infer<typeof CollisionFact>;

export const RepoChangeMap = z.strictObject({
  name: z.string().min(1),
  root: z.string().min(1),
  base: z.string().nullable(),
  files: z.array(ChangedFile),
  subsystems: z.array(SubsystemFact),
  coChangeGaps: z.array(CoChangeGap),
  hotspots: z.array(HotspotFact),
  blastRadius: z.array(BlastRadiusFact),
  untestedFiles: z.array(UntestedFileFact),
  collisions: z.array(CollisionFact),
  error: z.string().nullable(),
});
export type RepoChangeMap = z.infer<typeof RepoChangeMap>;

export const NarrativeClaim = z.strictObject({
  text: z.string().min(1).max(CHANGE_MAP_CLAIM_MAX_CHARS),
  factIds: z.array(factId).min(1),
});
export type NarrativeClaim = z.infer<typeof NarrativeClaim>;

export const ChangeNarrative = z.strictObject({
  factsHash: z.string().min(1),
  model: z.string().nullable(),
  claims: z.array(NarrativeClaim).max(CHANGE_MAP_CLAIMS_MAX),
});
export type ChangeNarrative = z.infer<typeof ChangeNarrative>;

export const NarratorState = z.enum(['disabled', 'pending', 'ready', 'failed']);
export type NarratorState = z.infer<typeof NarratorState>;

export const ChangeMap = z.strictObject({
  sessionId: z.string().min(1),
  sig: z.string().nullable(),
  generatedAt: z.number().finite(),
  repos: z.array(RepoChangeMap),
  narrative: ChangeNarrative.nullable(),
  narratorState: NarratorState,
  error: z.string().min(1).optional(),
});
export type ChangeMap = z.infer<typeof ChangeMap>;
