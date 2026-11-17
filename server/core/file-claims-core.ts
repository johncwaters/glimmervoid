import path from 'node:path';
import { changeMapFactId } from '../../shared/contracts/change-map.ts';
import type { CollisionFact } from '../../shared/contracts/change-map.ts';

const MAX_CLAIMS_PER_SESSION = 100;

interface FileClaim {
  projectPath: string;
  path: string;
  holderId: string;
  holderName: string;
  claimedAt: number;
}

type ClaimOutcome =
  | { kind: 'claimed'; claims: FileClaim[] }
  | { kind: 'already-yours'; claims: FileClaim[] }
  | { kind: 'held'; claims: FileClaim[]; holder: FileClaim }
  | { kind: 'full'; claims: FileClaim[] };

function pathKeyOf(relativePath: string, isCaseInsensitive: boolean): string {
  return isCaseInsensitive ? relativePath.toLowerCase() : relativePath;
}

function claimRelativePath(rootDir: string, cwd: string, requestedPath: string): string | null {
  const relativePath = path.relative(rootDir, path.resolve(cwd, requestedPath));
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
  return relativePath.split(path.sep).join('/');
}

function liveClaims(claims: readonly FileClaim[], isLive: (sessionId: string) => boolean): FileClaim[] {
  return claims.filter((claim) => isLive(claim.holderId));
}

function claimFile(claims: readonly FileClaim[], next: FileClaim, isCaseInsensitive: boolean): ClaimOutcome {
  const nextKey = pathKeyOf(next.path, isCaseInsensitive);
  const current = claims.find((claim) => claim.projectPath === next.projectPath && pathKeyOf(claim.path, isCaseInsensitive) === nextKey);
  if (current?.holderId === next.holderId) return { kind: 'already-yours', claims: [...claims] };
  if (current) return { kind: 'held', claims: [...claims], holder: current };
  if (claims.filter((claim) => claim.holderId === next.holderId).length >= MAX_CLAIMS_PER_SESSION) return { kind: 'full', claims: [...claims] };
  return { kind: 'claimed', claims: [...claims, next] };
}

function releaseFile(claims: readonly FileClaim[], projectPath: string, relativePath: string, holderId: string, isCaseInsensitive: boolean): FileClaim[] | null {
  const releasedKey = pathKeyOf(relativePath, isCaseInsensitive);
  const kept = claims.filter((claim) => !(claim.projectPath === projectPath && pathKeyOf(claim.path, isCaseInsensitive) === releasedKey && claim.holderId === holderId));
  return kept.length === claims.length ? null : kept;
}

function claimCollisions({ repoName, sessionPathPrefix, changedPaths, claimsByOthers, knownCollisions, isCaseInsensitive }: {
  repoName: string;
  sessionPathPrefix: string;
  changedPaths: readonly string[];
  claimsByOthers: readonly FileClaim[];
  knownCollisions: readonly CollisionFact[];
  isCaseInsensitive: boolean;
}): CollisionFact[] {
  const changedPathByKey = new Map(changedPaths.map((changedPath) => [pathKeyOf(`${sessionPathPrefix}${changedPath}`, isCaseInsensitive), changedPath]));
  return claimsByOthers.flatMap((claim) => {
    const changedPath = changedPathByKey.get(pathKeyOf(claim.path, isCaseInsensitive));
    if (changedPath === undefined) return [];
    if (knownCollisions.some((fact) => fact.path === changedPath && fact.otherSessionId === claim.holderId)) return [];
    return [{
      factId: changeMapFactId('collision', repoName, changedPath, claim.holderId),
      path: changedPath,
      otherSessionId: claim.holderId,
      otherSessionName: claim.holderName,
      conflictRisk: 'medium' as const,
      conflictEvidence: `${claim.holderName} claimed this file and may be editing it`,
    }];
  });
}

export { claimCollisions, claimFile, claimRelativePath, liveClaims, releaseFile };
export type { FileClaim };
