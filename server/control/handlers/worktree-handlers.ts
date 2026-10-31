import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import type { ChangeMap } from '../../../shared/contracts/change-map.ts';
import { errorMessage } from '../../../shared/text.ts';
import type { Session } from '../../../session/sessions.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import { createChangeMapService, joinSessionRegistries } from '../../change-map/change-map-wiring.ts';
import { createChangesWatch } from '../../changes-watch.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { firstGitErrorLine } from '../../core/branch-sync-core.ts';
import type { ControlContext } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable } from '../core/control-dispatch-core.ts';

const MERGE_REFUSAL_COPY: Record<string, string> = {
  'destroyed':         'session no longer exists',
  'no-worktree':       'no worktree to merge',
  'merge-in-progress': 'a merge is already in flight on this worktree',
};

function reportMergeRefusal(ws: ControlSocket, s: Session, r: { refused?: boolean; reason?: string | null } | null | undefined): void {
  if (r?.refused !== true) return;
  const detail = r.reason === 'not-continuable'
    ? `session state ${s.state} is not mergeable`
    : ((r.reason ? MERGE_REFUSAL_COPY[r.reason] : '') || r.reason);
  console.log(`[control] merge refused: id=${s.id} state=${s.state} reason=${r.reason}`);
  ws.send(JSON.stringify({ type: 'session-error', id: s.id, session: s.name, message: `Merge refused: ${detail}.` }));
}

function createWorktreeHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { sessions, agentSessions, findSession } = context;

  const changeMaps = deps.changeMaps ?? createChangeMapService({ sessions: joinSessionRegistries(sessions, agentSessions) });
  const changesWatch = createChangesWatch<ControlSocket>({
    findSession: (id) => sessions.get(id) ?? agentSessions.get(id) ?? null,
    isHolderOpen: (ws) => ws.readyState === 1,
  });

  const handlers = {
    'merge-session': async (msg: ClientMessageOf<'merge-session'>, ws: ControlSocket) => { const s = findSession(msg); if (s) reportMergeRefusal(ws, s, await s.mergeWorktree()); },
    'finish-session': (msg: ClientMessageOf<'finish-session'>) => { const s = findSession(msg); if (s) s.finishAndMerge(); },
    'merge-continue-session': async (msg: ClientMessageOf<'merge-continue-session'>, ws: ControlSocket) => { const s = findSession(msg); if (s) reportMergeRefusal(ws, s, await s.mergeAndContinue({ force: msg.force === true })); },
    'discard-session-worktree': (msg: ClientMessageOf<'discard-session-worktree'>) => { const s = findSession(msg); if (s) s.discardWorktree(); },
    'resolve-session-merge': (msg: ClientMessageOf<'resolve-session-merge'>) => { const s = findSession(msg); if (s) s.pasteMergePrompt(); },
    'request-session-diff': async (msg: ClientMessageOf<'request-session-diff'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;

      try {
        const diff = await s.getDiff();
        ws.send(JSON.stringify({ ...diff, type: 'session-diff', id: s.id }));
      } catch (error) {
        console.warn(`[control] request-session-diff failed: id=${s.id}: ${errorMessage(error)}`);
        ws.send(JSON.stringify({ type: 'session-diff-error', id: s.id, message: firstGitErrorLine(error) }));
      }
    },
    'watch-session-changes': (msg: ClientMessageOf<'watch-session-changes'>, ws: ControlSocket) => changesWatch.request(ws, msg.id),
    'request-change-map': async (msg: ClientMessageOf<'request-change-map'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      const map = await changeMaps.build(s).catch((error: unknown): ChangeMap => {
        console.warn(`[control] request-change-map build failed: id=${s.id}: ${errorMessage(error)}`);
        return {
          sessionId: s.id, sig: null, generatedAt: Date.now(), repos: [],
          error: `Change map could not be built: ${errorMessage(error)}`,
        };
      });
      ws.send(JSON.stringify({ type: 'change-map', id: s.id, map }));
    },
    'request-branch-sync': async (msg: ClientMessageOf<'request-branch-sync'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      const sync = await s.getBranchSync();
      ws.send(JSON.stringify({ type: 'branch-sync-status', id: s.id, ...sync }));
    },
    'resync-branch': async (msg: ClientMessageOf<'resync-branch'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      const sync = await s.resyncBranch();
      ws.send(JSON.stringify({ type: 'branch-sync-status', id: s.id, ...sync }));
    },
  } satisfies ControlHandlerTable;

  return { handlers, genericErrorTypes: ['request-session-diff', 'request-change-map', 'request-branch-sync', 'resync-branch'] };
}

export { createWorktreeHandlers };
