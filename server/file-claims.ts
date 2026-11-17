import { claimFile, claimRelativePath, liveClaims, releaseFile } from './core/file-claims-core.ts';
import type { FileClaim } from './core/file-claims-core.ts';
import type { AgentClaimReply, AgentClaimRequest } from '../shared/contracts/file-claims.ts';
import { clock } from '../shared/clock.ts';

interface ClaimingSession {
  id: string;
  name: string;
  projectPath: string;
  rootDir: string;
  cwd: string;
}

const IS_CASE_INSENSITIVE_FILESYSTEM = process.platform === 'win32' || process.platform === 'darwin';

type ClaimHandling = { ok: true; reply: AgentClaimReply } | { ok: false; status: number; error: string };

function createFileClaims({ findLiveSession }: { findLiveSession: (sessionId: string) => { path: string } | null }) {
  let claims: FileClaim[] = [];

  function currentClaims(): FileClaim[] {
    claims = liveClaims(claims, (sessionId) => findLiveSession(sessionId) !== null);
    return claims;
  }

  function addClaim(caller: ClaimingSession, relativePath: string): ClaimHandling {
    const outcome = claimFile(currentClaims(), { projectPath: caller.projectPath, path: relativePath, holderId: caller.id, holderName: caller.name, claimedAt: clock.nowMs() }, IS_CASE_INSENSITIVE_FILESYSTEM);
    claims = outcome.claims;
    if (outcome.kind === 'full') return { ok: false, status: 409, error: 'this session already holds 100 claims, so release one first' };
    if (outcome.kind === 'held') {
      const note = `${outcome.holder.holderName} (${outcome.holder.holderId}) already claimed ${relativePath}; claims never block, so coordinate with glimmervoid send --to ${outcome.holder.holderId} or edit with care`;
      return { ok: true, reply: { ok: true, claimed: relativePath, note } };
    }
    return { ok: true, reply: { ok: true, claimed: relativePath, note: `this session claims ${relativePath} until it ends or releases it; other sessions see the claim but are not blocked` } };
  }

  function handle(caller: ClaimingSession, request: AgentClaimRequest): ClaimHandling {
    if (request.sub === 'list') {
      const rows = currentClaims().filter((claim) => claim.projectPath === caller.projectPath).map(({ path, holderId, holderName, claimedAt }) => ({ path, holderId, holderName, claimedAt }));
      return { ok: true, reply: { ok: true, claims: rows } };
    }
    const relativePath = claimRelativePath(caller.rootDir, caller.cwd, request.path);
    if (relativePath === null) return { ok: false, status: 400, error: `${request.path} is not a file inside this session's checkout` };
    if (request.sub === 'add') return addClaim(caller, relativePath);
    const kept = releaseFile(currentClaims(), caller.projectPath, relativePath, caller.id, IS_CASE_INSENSITIVE_FILESYSTEM);
    if (kept === null) return { ok: false, status: 404, error: `this session holds no claim on ${relativePath}` };
    claims = kept;
    return { ok: true, reply: { ok: true, released: relativePath } };
  }

  function claimsByOthersOf(sessionId: string): FileClaim[] {
    const self = findLiveSession(sessionId);
    if (!self) return [];
    return currentClaims().filter((claim) => claim.projectPath === self.path && claim.holderId !== sessionId);
  }

  return { handle, claimsByOthersOf };
}

type FileClaims = ReturnType<typeof createFileClaims>;

export { IS_CASE_INSENSITIVE_FILESYSTEM, createFileClaims };
export type { FileClaims };
