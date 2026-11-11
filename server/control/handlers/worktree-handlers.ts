import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import type { ChangeMap } from '../../../shared/contracts/change-map.ts';
import { errorMessage } from '../../../shared/text.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import { createChangeMapService, joinSessionRegistries } from '../../change-map/change-map-wiring.ts';
import { createChangesWatch } from '../../changes-watch.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { firstGitErrorLine } from '../../core/branch-sync-core.ts';
import type { ControlContext } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

function createWorktreeHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { sessions, agentSessions, findSession } = context;

  const changeMaps = deps.changeMaps ?? createChangeMapService({ sessions: joinSessionRegistries(sessions, agentSessions) });
  const changesWatch = createChangesWatch<ControlSocket>({
    findSession: (id) => sessions.get(id) ?? agentSessions.get(id) ?? null,
    isHolderOpen: (ws) => ws.readyState === 1,
  });

  const handlers = {
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
    'request-diff-file': async (msg: ClientMessageOf<'request-diff-file'>, ws: ControlSocket) => {
      const reply = { type: 'diff-file', requestId: msg.requestId ?? null, id: msg.id, path: msg.path };
      const s = findSession(msg);
      if (!s) return ws.send(JSON.stringify({ ...reply, ok: false, oldContents: null, newContents: null, error: 'Session not found' }));
      try {
        const contents = await s.getDiffFileContents({ path: msg.path, oldBlobId: msg.oldBlobId, newBlobId: msg.newBlobId });
        if (!contents.ok) return ws.send(JSON.stringify({ ...reply, ok: false, oldContents: null, newContents: null, error: contents.error }));
        ws.send(JSON.stringify({ ...reply, ...contents }));
      } catch (error) {
        ws.send(JSON.stringify({ ...reply, ok: false, oldContents: null, newContents: null, error: firstGitErrorLine(error) }));
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

  const invalidReplies = {
    'request-diff-file': (msg, requestId, message) => ({ type: 'diff-file', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', ok: false, oldContents: null, newContents: null, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, genericErrorTypes: ['request-session-diff', 'request-change-map', 'request-branch-sync', 'resync-branch'] };
}

export { createWorktreeHandlers };
