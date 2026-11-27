import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import type { ChangeMap } from '../../../shared/contracts/change-map.ts';
import { errorMessage } from '../../../shared/text.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import { createChangesWatch } from '../../changes-watch.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { firstGitErrorLine } from '../../core/branch-sync-core.ts';
import type { ControlContext } from '../control-context.ts';
import { SESSION_GONE_TEXT } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';
import { clock } from '../../../shared/clock.ts';

function createWorktreeHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const { sessions, agentSessions, findSession, replyApplied } = context;

  const { changeMaps } = deps;
  const changesWatch = createChangesWatch<ControlSocket>({
    findSession: (id) => sessions.get(id) ?? agentSessions.get(id) ?? null,
  });

  const handlers = {
    'resolve-session-merge': (msg: ClientMessageOf<'resolve-session-merge'>, ws: ControlSocket) => {
      const session = findSession(msg);
      if (!session) {
        replyApplied(ws, msg, 'session-action-result', { id: msg.id, ok: false, error: SESSION_GONE_TEXT });
        return;
      }
      const outcome = session.pasteMergePrompt();
      const isPasted = outcome.ok === true;
      const reason = typeof outcome.reason === 'string' ? outcome.reason : 'Merge prompt could not be pasted.';
      replyApplied(ws, msg, 'session-action-result', { id: session.id, ok: isPasted, error: isPasted ? null : reason });
    },
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
          sessionId: s.id, sig: null, generatedAt: clock.nowMs(), repos: [],
          error: `Change map could not be built: ${errorMessage(error)}`,
        };
      });
      ws.send(JSON.stringify({ type: 'change-map', id: s.id, map }));
    },
    'request-verification': (msg: ClientMessageOf<'request-verification'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      ws.send(JSON.stringify({ type: 'verification-run', id: s.id, run: deps.verification?.latestRun(s.id) ?? null }));
    },
    'request-session-review': (msg: ClientMessageOf<'request-session-review'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      ws.send(JSON.stringify({ type: 'session-review', id: s.id, result: deps.sessionReview?.latest(s.id) ?? null }));
    },
    'run-session-review': (msg: ClientMessageOf<'run-session-review'>, ws: ControlSocket) => {
      const session = findSession(msg);
      if (!session) {
        replyApplied(ws, msg, 'session-action-result', { id: msg.id, ok: false, error: SESSION_GONE_TEXT });
        return;
      }
      if (!deps.sessionReview) {
        replyApplied(ws, msg, 'session-action-result', { id: session.id, ok: false, error: 'Session review is not available on this server.' });
        return;
      }
      void deps.sessionReview.run(session);
      replyApplied(ws, msg, 'session-action-result', { id: session.id, ok: true, error: null });
    },
    'request-branch-sync': async (msg: ClientMessageOf<'request-branch-sync'>, ws: ControlSocket) => {
      const s = findSession(msg);
      if (!s) return;
      const sync = await s.getBranchSync();
      ws.send(JSON.stringify({ type: 'branch-sync-status', id: s.id, ...sync }));
    },
    'resync-branch': async (msg: ClientMessageOf<'resync-branch'>, ws: ControlSocket) => {
      const session = findSession(msg);
      if (!session) {
        replyApplied(ws, msg, 'resync-branch-result', {
          id: msg.id, branch: null, upstream: null, state: 'error', ahead: 0, behind: 0, fetched: null, action: 'none', error: SESSION_GONE_TEXT,
        });
        return;
      }
      const sync = await session.resyncBranch();
      replyApplied(ws, msg, 'resync-branch-result', { id: session.id, ...sync });
    },
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'request-diff-file': (msg, requestId, message) => ({ type: 'diff-file', requestId, id: typeof msg?.id === 'string' ? msg.id : '', path: typeof msg?.path === 'string' ? msg.path : '', ok: false, oldContents: null, newContents: null, error: message }),
    'resolve-session-merge': (msg, requestId, message) => ({ type: 'session-action-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
    'resync-branch': (msg, requestId, message) => ({ type: 'resync-branch-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', branch: null, upstream: null, state: 'error', ahead: 0, behind: 0, fetched: null, action: 'none', error: message }),
    'run-session-review': (msg, requestId, message) => ({ type: 'session-action-result', requestId, id: typeof msg?.id === 'string' ? msg.id : '', ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, genericErrorTypes: ['request-session-diff', 'request-change-map', 'request-branch-sync'] };
}

export { createWorktreeHandlers };
