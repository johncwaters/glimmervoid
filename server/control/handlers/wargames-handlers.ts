import { randomUUID } from 'node:crypto';

import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { createWargamesLauncher } from '../../wargames/wargames-launch.ts';
import type { WargamesLauncher } from '../../wargames/wargames-launch.ts';
import type { ControlContext } from '../control-context.ts';
import { replyTo } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

export function createWargamesHandlers(
  context: ControlContext,
  deps: ControlHandlerDeps,
): ControlHandlerGroup & { launcher: WargamesLauncher } {
  const { sessions, createProjectSession } = context;
  const { config, wargames = null } = deps;
  const watcherIdBySocket = new WeakMap<ControlSocket, string>();
  const launcher = createWargamesLauncher({
    wargames,
    sessions,
    config,
    createProjectSession,
  });

  function watcherIdFor(ws: ControlSocket): string {
    const existing = watcherIdBySocket.get(ws);
    if (existing) return existing;
    const created = randomUUID();
    watcherIdBySocket.set(ws, created);
    ws.once('close', () => { wargames?.removeWatcher(created); });
    return created;
  }

  async function handleStart(msg: ClientMessageOf<'wargames-start'>, ws: ControlSocket): Promise<void> {
    const started = await launcher.start(msg.spec);
    replyTo(
      ws,
      msg,
      'wargames-start-result',
      started.ok ? { ok: true, error: started.error, matchId: started.matchId } : { ok: false, error: started.error },
    );
  }

  async function handleAbort(msg: ClientMessageOf<'wargames-abort'>, ws: ControlSocket): Promise<void> {
    const aborted = wargames
      ? await wargames.abortMatch(msg.matchId, msg.reason ?? 'Aborted by operator')
      : { ok: false as const, error: 'Wargames is not running' };
    replyTo(ws, msg, 'wargames-abort-result', aborted.ok ? { ok: true, error: null } : { ok: false, error: aborted.error });
  }

  async function handleWatch(msg: ClientMessageOf<'wargames-watch'>, ws: ControlSocket): Promise<void> {
    if (!wargames) {
      replyTo(ws, msg, 'wargames-watch-result', { ok: false, error: 'Wargames is not running' });
      return;
    }
    const watched = await wargames.watchMatch(msg.matchId, watcherIdFor(ws));
    if (!watched.ok) {
      replyTo(ws, msg, 'wargames-watch-result', { ok: false, error: watched.error });
      return;
    }
    ws.send(JSON.stringify({ type: 'wargames-events', matchId: msg.matchId, events: watched.events, reset: true }));
    replyTo(ws, msg, 'wargames-watch-result', { ok: true, error: null, matchId: msg.matchId });
  }

  function handleUnwatch(msg: ClientMessageOf<'wargames-unwatch'>, ws: ControlSocket): void {
    wargames?.unwatchMatch(msg.matchId, watcherIdFor(ws));
  }

  const handlers = {
    'wargames-start': handleStart,
    'wargames-abort': handleAbort,
    'wargames-watch': handleWatch,
    'wargames-unwatch': handleUnwatch,
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'wargames-start': (_msg, requestId, message) => ({ type: 'wargames-start-result', requestId, ok: false, error: message }),
    'wargames-abort': (_msg, requestId, message) => ({ type: 'wargames-abort-result', requestId, ok: false, error: message }),
    'wargames-watch': (_msg, requestId, message) => ({ type: 'wargames-watch-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return {
    handlers,
    invalidReplies,
    connectFrames: () => (wargames ? [wargames.statusFrame(), wargames.historyFrame()] : []),
    launcher,
  };
}
