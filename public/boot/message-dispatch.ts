import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { onControlMessage } from '../control-ws.ts';
import { mergeMessageHandlerGroups } from './core/message-dispatch-core.ts';
import { faceHandlers } from './handlers/face-handlers.ts';
import { githubHandlers } from './handlers/github-handlers.ts';
import { laneHandlers } from './handlers/lane-handlers.ts';
import { serverHandlers } from './handlers/server-handlers.ts';
import { sessionHandlers } from './handlers/session-handlers.ts';
import { whiteboardHandlers } from './handlers/whiteboard-handlers.ts';
import { worktreeHandlers } from './handlers/worktree-handlers.ts';
import { refreshViewsIfVisible } from './view-tabs.ts';

const handlersByType = mergeMessageHandlerGroups([serverHandlers, sessionHandlers, worktreeHandlers, faceHandlers, whiteboardHandlers, githubHandlers, laneHandlers]);

function dispatchControlMessage<Type extends ServerMessage['type']>(message: { [Variant in ServerMessage['type']]: ServerMessageOf<Variant> }[Type]) {
  const handler = handlersByType[message.type];
  if (handler) handler(message);
}

function wireMessageDispatch() {
  onControlMessage((msg) => {
    dispatchControlMessage(msg);
    refreshViewsIfVisible(msg.type);
  });
}

export { wireMessageDispatch };
