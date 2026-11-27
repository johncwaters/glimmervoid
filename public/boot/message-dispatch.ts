import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { UNREADABLE_SERVER_MESSAGE_TEXT, onUnreadableServerMessage } from '../control-ws.ts';
import { reportHeaderError } from '../action-status.ts';
import { startIngest } from '../state/ingest.ts';
import { mergeMessageHandlerGroups } from './core/message-dispatch-core.ts';
import { faceHandlers } from './handlers/face-handlers.ts';
import { githubHandlers } from './handlers/github-handlers.ts';
import { laneHandlers } from './handlers/lane-handlers.ts';
import { serverHandlers } from './handlers/server-handlers.ts';
import { sessionHandlers } from './handlers/session-handlers.ts';
import { whiteboardHandlers } from './handlers/whiteboard-handlers.ts';
import { worktreeHandlers } from './handlers/worktree-handlers.ts';
import { refreshViewsIfVisible } from './view-tabs.ts';
import { packBridgeHandlers } from '../packs/pack-bridge-host.ts';

const handlersByType = mergeMessageHandlerGroups([serverHandlers, sessionHandlers, worktreeHandlers, faceHandlers, whiteboardHandlers, githubHandlers, laneHandlers, packBridgeHandlers]);

function dispatchControlMessage<Type extends ServerMessage['type']>(message: { [Variant in ServerMessage['type']]: ServerMessageOf<Variant> }[Type]) {
  const handler = handlersByType[message.type];
  if (handler) handler(message);
}

const STALE_DASHBOARD_ERROR_SOURCE = 'Dashboard';
let hasShownStaleDashboardError = false;

function showStaleDashboardError() {
  if (hasShownStaleDashboardError) return;
  hasShownStaleDashboardError = true;
  reportHeaderError({ source: STALE_DASHBOARD_ERROR_SOURCE, message: UNREADABLE_SERVER_MESSAGE_TEXT });
}

function wireMessageDispatch() {
  onUnreadableServerMessage(showStaleDashboardError);
  startIngest(dispatchControlMessage, (msg) => {
    refreshViewsIfVisible(msg.type);
  });
}

export { wireMessageDispatch };
