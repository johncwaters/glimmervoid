import type { RemovalCause } from '../../shared/contracts/removal-record.ts';

const SESSION_WORK_RECENCY_FLOOR_MS = 24 * 60 * 60 * 1000;
const AUTOMATIC_REMOVAL_CAUSES: ReadonlySet<RemovalCause> = new Set(['branch-gc', 'boot-reconcile', 'owned-paths']);
const SESSION_OWNER_PREFIX = 'session:';

type RemovalOwnershipFacts = {
  cause: RemovalCause;
  sessionId: string | null;
  ledgerOwnerSessionId: string | null;
  protectedSessionIds: ReadonlySet<string>;
};

type KeepVerdict =
  | { keep: true; reason: 'protected-session' | 'ledger-owned' | 'recently-touched' | 'touch-probe-failed' }
  | { keep: false; checksPassed: string[] };

function sessionIdFromOwner(owner: string | null): string | null {
  if (owner === null || !owner.startsWith(SESSION_OWNER_PREFIX)) return null;
  return owner.slice(SESSION_OWNER_PREFIX.length);
}

function isRecencyProbeNeeded(facts: RemovalOwnershipFacts): boolean {
  return decideKeepByOwnership(facts) === null;
}

function decideKeepByOwnership(facts: RemovalOwnershipFacts): KeepVerdict | null {
  if (!AUTOMATIC_REMOVAL_CAUSES.has(facts.cause)) return { keep: false, checksPassed: ['explicit-cause'] };
  if (facts.sessionId === null && facts.ledgerOwnerSessionId === null) return { keep: false, checksPassed: ['not-session-work'] };
  if (facts.sessionId !== null && facts.protectedSessionIds.has(facts.sessionId)) return { keep: true, reason: 'protected-session' };
  if (facts.ledgerOwnerSessionId !== null && facts.protectedSessionIds.has(facts.ledgerOwnerSessionId)) return { keep: true, reason: 'ledger-owned' };
  return null;
}

function decideRemovalKeep(facts: RemovalOwnershipFacts & { lastTouchedMs: number | null; nowMs: number }): KeepVerdict {
  const byOwnership = decideKeepByOwnership(facts);
  if (byOwnership !== null) return byOwnership;
  if (facts.lastTouchedMs === null) return { keep: true, reason: 'touch-probe-failed' };
  if (facts.nowMs - facts.lastTouchedMs < SESSION_WORK_RECENCY_FLOOR_MS) return { keep: true, reason: 'recently-touched' };
  return { keep: false, checksPassed: ['not-protected', 'not-ledger-owned', 'untouched-24h'] };
}

export { decideRemovalKeep, isRecencyProbeNeeded, sessionIdFromOwner };
export type { RemovalOwnershipFacts };
